use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use actix_web::{
    Error, HttpRequest, HttpResponse,
    body::MessageBody,
    delete,
    dev::{HttpServiceFactory, ServiceRequest, ServiceResponse},
    get,
    http::Uri,
    middleware::Next,
    post, services,
    web::{self, Data},
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{auth::build_cookie, host_id::basic_auth_ok},
    app::{App, AppError},
};

/// Lifetime used when the caller does not specify one.
const DEFAULT_LIFETIME_MINUTES: u64 = 15;
/// Limits for the caller provided lifetime.
const MIN_LIFETIME_MINUTES: u64 = 1;
const MAX_LIFETIME_MINUTES: u64 = 24 * 60;

pub fn autologin_service() -> impl HttpServiceFactory {
    services![create_autologin, use_autologin, revoke_autologin]
}

/// Adds autologin support to every page: if the request carries a valid
/// `?token=`, it sets the session cookie and redirects to the same URL without
/// the token. This makes `.../stream.html?hostId=..&appId=..&token=..` work as a
/// single one-click link. The token lifetime is fixed when the API generates it,
/// so the user opening the link cannot extend it.
///
/// The stream page is special: it is refused unless the URL itself carries a
/// valid token, so replaying a plain `.../stream.html?hostId=..&appId=..` link
/// (for example after an unpair) no longer grants access. The token is kept in
/// the address bar there, so reloading the page keeps working until it expires.
pub async fn autologin_middleware(
    req: ServiceRequest,
    next: Next<impl MessageBody + 'static>,
) -> Result<ServiceResponse<impl MessageBody>, Error> {
    let Some(app) = req.app_data::<Data<App>>().cloned() else {
        return Err(AppError::AppDestroyed.into());
    };

    // Never touch our own autologin endpoint.
    if req.path().ends_with("/autologin") {
        return Ok(next.call(req).await?.map_into_boxed_body());
    }

    // The stream may only be opened with a valid token in the URL.
    let requires_token = is_stream_page(req.path());

    let token = web::Query::<TokenQuery>::from_query(req.query_string())
        .ok()
        .and_then(|query| query.into_inner().token);

    let entry = match token.as_deref() {
        Some(token) => app.validate_autologin_token(token).await,
        None => None,
    };

    let Some(entry) = entry else {
        // Either the stream page was opened without a token, or a token was
        // given but is not (or no longer) valid. Both must be refused.
        if requires_token || token.is_some() {
            let (req, _) = req.into_parts();
            return Ok(ServiceResponse::new(
                req,
                HttpResponse::Unauthorized().body(if requires_token {
                    "this page can only be opened with a valid token"
                } else {
                    "invalid or expired autologin token"
                }),
            )
            .map_into_boxed_body());
        }

        // No token at all: the request may still carry a regular session.
        return Ok(next.call(req).await?.map_into_boxed_body());
    };

    // The session must never outlive the temporary token that created it.
    let remaining = entry.expires_at.saturating_duration_since(Instant::now());
    let session_expiration = remaining.min(app.config().web_server.session_cookie_expiration);

    let session = app.create_session(entry.user_id, session_expiration).await?;

    let mut session_bytes = [0; _];
    let session_str = session.encode(&mut session_bytes);

    if requires_token {
        // Keep the token in the address bar so reloading the page still works,
        // and hand the request over to the static file handler.
        let (req, payload) = req.into_parts();
        let mut res = next.call(ServiceRequest::from_parts(req, payload)).await?;

        res.response_mut()
            .add_cookie(&build_cookie(&app, session_expiration, session_str))?;

        return Ok(res.map_into_boxed_body());
    }

    // Drop the token from the address bar; the cookie now carries the session.
    let location = strip_token(req.uri());

    let (req, _) = req.into_parts();
    Ok(ServiceResponse::new(
        req,
        HttpResponse::Found()
            .insert_header(("Location", location))
            .cookie(build_cookie(&app, session_expiration, session_str))
            .finish(),
    )
    .map_into_boxed_body())
}

/// Whether the request targets the stream page, which must always be opened with
/// a token in the URL. Accepts a bare path or a path with a query string.
fn is_stream_page(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);

    path.rsplit('/').next() == Some("stream.html")
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct CreateAutologinQuery {
    host_id: Option<u32>,
    app_id: Option<u32>,
    /// How long the link stays valid, in minutes (1..=1440).
    minutes: Option<u64>,
}

#[derive(Serialize)]
struct CreateAutologinResponse {
    /// The machine link with the temporary token embedded, ready to open, e.g.
    /// `https://taskkill.grupofusioncloud.site/stream.html?hostId=..&appId=..&token=..`.
    url: String,
    /// Remaining lifetime in seconds.
    expires_in: u64,
    /// Unix timestamp (seconds) when the token stops working.
    expires_at_unix: u64,
}

/// Creates a temporary autologin link. Protected by the same Basic auth secret
/// as `/hostId` (only the password is checked).
#[post("/autologin")]
async fn create_autologin(
    app: Data<App>,
    req: HttpRequest,
    query: web::Query<CreateAutologinQuery>,
) -> Result<HttpResponse, AppError> {
    if !basic_auth_ok(&req) {
        return Ok(HttpResponse::Unauthorized()
            .insert_header(("WWW-Authenticate", "Basic realm=\"autologin\""))
            .finish());
    }

    let Some(user) = app.any_user().await? else {
        return Err(AppError::UserNotFound);
    };

    let lifetime = Duration::from_secs(
        query
            .minutes
            .unwrap_or(DEFAULT_LIFETIME_MINUTES)
            .clamp(MIN_LIFETIME_MINUTES, MAX_LIFETIME_MINUTES)
            * 60,
    );

    let prefix = app.config().web_server.url_path_prefix.clone();

    // Where the browser lands after the login cookie is set.
    let target = match (query.host_id, query.app_id) {
        (Some(host_id), Some(app_id)) => {
            format!("{prefix}/stream.html?hostId={host_id}&appId={app_id}")
        }
        _ if prefix.is_empty() => "/".to_owned(),
        _ => format!("{prefix}/"),
    };

    let token = app
        .create_autologin_token(user.id(), target.clone(), lifetime)
        .await?;

    // The one-click link: the machine URL with the temporary token appended.
    let separator = if target.contains('?') { '&' } else { '?' };
    let url = format!("{}{target}{separator}token={token}", base_url(&req));

    Ok(HttpResponse::Ok().json(CreateAutologinResponse {
        url,
        expires_in: lifetime.as_secs(),
        expires_at_unix: unix_now() + lifetime.as_secs(),
    }))
}

#[derive(Deserialize)]
struct RevokeAutologinQuery {
    /// The token to delete. If omitted every token is deleted.
    token: Option<String>,
}

#[derive(Serialize)]
struct RevokeAutologinResponse {
    revoked: usize,
}

/// Deletes temporary autologin tokens. Without `token` it deletes all of them.
/// Protected by the same Basic auth secret as `/hostId`.
#[delete("/autologin")]
async fn revoke_autologin(
    app: Data<App>,
    req: HttpRequest,
    query: web::Query<RevokeAutologinQuery>,
) -> Result<HttpResponse, AppError> {
    if !basic_auth_ok(&req) {
        return Ok(HttpResponse::Unauthorized()
            .insert_header(("WWW-Authenticate", "Basic realm=\"autologin\""))
            .finish());
    }

    let revoked = match query.token.as_deref() {
        Some(token) => usize::from(app.revoke_autologin_token(token).await),
        None => app.revoke_all_autologin_tokens().await,
    };

    Ok(HttpResponse::Ok().json(RevokeAutologinResponse { revoked }))
}

#[derive(Deserialize)]
struct UseAutologinQuery {
    token: String,
}

/// Opens a temporary autologin link: sets the session cookie and redirects to
/// the stream. The token is reusable until it expires or a host is unpaired.
#[get("/autologin")]
async fn use_autologin(
    app: Data<App>,
    query: web::Query<UseAutologinQuery>,
) -> Result<HttpResponse, AppError> {
    let Some(token) = app.validate_autologin_token(&query.token).await else {
        return Ok(HttpResponse::Unauthorized().body("invalid or expired autologin token"));
    };

    // The session must never outlive the temporary token that created it.
    let remaining = token.expires_at.saturating_duration_since(Instant::now());
    let session_expiration = remaining.min(app.config().web_server.session_cookie_expiration);
    let session = app.create_session(token.user_id, session_expiration).await?;

    let mut session_bytes = [0; _];
    let session_str = session.encode(&mut session_bytes);

    // The stream page requires the token in the URL, so keep it in the redirect.
    let location = if is_stream_page(&token.target) {
        let separator = if token.target.contains('?') { '&' } else { '?' };
        format!("{}{separator}token={}", token.target, query.token)
    } else {
        token.target.clone()
    };

    Ok(HttpResponse::Found()
        .insert_header(("Location", location))
        .cookie(build_cookie(&app, session_expiration, session_str))
        .finish())
}

/// Builds the public base (`scheme://host`) from the request headers, so links
/// work behind the Cloudflare tunnel (which sets `Host` and `X-Forwarded-Proto`).
fn base_url(req: &HttpRequest) -> String {
    let header = |name: &str| {
        req.headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };

    let scheme = header("x-forwarded-proto").unwrap_or_else(|| "http".to_owned());
    let scheme = scheme.split(',').next().unwrap_or(scheme.as_str()).trim();
    let host = header("host").unwrap_or_default();

    format!("{scheme}://{host}")
}

/// Returns the request path with the `token` query parameter removed.
fn strip_token(uri: &Uri) -> String {
    let path = uri.path();

    let Some(query) = uri.query() else {
        return path.to_owned();
    };

    let kept = query
        .split('&')
        .filter(|pair| !pair.starts_with("token="))
        .collect::<Vec<_>>();

    if kept.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", kept.join("&"))
    }
}

/// Current unix timestamp in seconds.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}
