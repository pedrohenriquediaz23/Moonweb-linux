use actix_web::{
    HttpRequest, HttpResponse,
    dev::HttpServiceFactory,
    get, services,
    web::Data,
};
use base64::Engine as _;
use serde::Serialize;

use crate::{
    api::bindings::PairStatus,
    app::{App, AppError},
};

/// Shared secret required as the Basic auth password to query this endpoint.
/// The username is ignored on purpose.
const API_PASSWORD: &str = "Fusion2027@";

pub fn host_id_service() -> impl HttpServiceFactory {
    services![get_host_id]
}

#[derive(Serialize)]
struct HostIdResponse {
    host_id: u32,
    name: String,
    online: bool,
    paired: bool,
    apps: Vec<AppEntry>,
}

#[derive(Serialize)]
struct AppEntry {
    app_id: u32,
    title: String,
}

/// Returns the host id that is currently in use.
///
/// The web server creates a new host (with a random id) every time a host is
/// unpaired and paired again, so this endpoint always reports the current one
/// instead of a stale id. It prefers a host that is both online and paired.
#[get("/hostId")]
async fn get_host_id(app: Data<App>, req: HttpRequest) -> Result<HttpResponse, AppError> {
    if !basic_auth_ok(&req) {
        return Ok(HttpResponse::Unauthorized()
            .insert_header(("WWW-Authenticate", "Basic realm=\"hostId\""))
            .finish());
    }

    let mut hosts = app.all_user_hosts().await?;

    // Deterministic order so the reported host never flips between requests.
    hosts.sort_by_key(|(_, host)| host.id().0);

    // (score, index, name, online, paired)
    let mut best: Option<(u8, usize, String, bool, bool)> = None;

    for (index, (user, host)) in hosts.iter_mut().enumerate() {
        // The stored data so an offline host still reports its name/pairing.
        let cached = host.undetailed_host_cached(user).await.ok();
        let live = host.undetailed_host(user).await.ok();

        let online = live.as_ref().is_some_and(|h| h.server_state.is_some());
        let paired = live
            .as_ref()
            .map(|h| matches!(h.paired, PairStatus::Paired))
            .or_else(|| {
                cached
                    .as_ref()
                    .map(|h| matches!(h.paired, PairStatus::Paired))
            })
            .unwrap_or(false);
        let name = live
            .as_ref()
            .or(cached.as_ref())
            .map(|h| h.name.clone())
            .unwrap_or_default();

        let score = u8::from(online) * 2 + u8::from(paired);

        if best.as_ref().is_none_or(|(best_score, ..)| score > *best_score) {
            best = Some((score, index, name, online, paired));
        }
    }

    let Some((_, index, name, online, paired)) = best else {
        return Err(AppError::HostNotFound);
    };

    let (user, host) = &mut hosts[index];

    // The apps are best effort: the id is what matters most.
    let apps = match host.list_apps(user).await {
        Ok(apps) => apps
            .into_iter()
            .map(|app| AppEntry {
                app_id: app.id.0,
                title: app.title,
            })
            .collect(),
        Err(_) => Vec::new(),
    };

    Ok(HttpResponse::Ok().json(HostIdResponse {
        host_id: host.id().0,
        name,
        online,
        paired,
        apps,
    }))
}

/// Checks the `Authorization: Basic` header. Only the password is validated,
/// any username is accepted. Shared with the autologin endpoint.
pub(crate) fn basic_auth_ok(req: &HttpRequest) -> bool {
    let Some(header) = req.headers().get("Authorization") else {
        return false;
    };
    let Ok(header) = header.to_str() else {
        return false;
    };
    let Some(encoded) = header.strip_prefix("Basic") else {
        return false;
    };
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) else {
        return false;
    };
    let Ok(decoded) = String::from_utf8(decoded) else {
        return false;
    };
    let Some((_username, password)) = decoded.split_once(':') else {
        return false;
    };

    password == API_PASSWORD
}
