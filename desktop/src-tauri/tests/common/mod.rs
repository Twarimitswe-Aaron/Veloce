use std::sync::Arc;

use veloce_desktop_lib::config::Config;
use veloce_desktop_lib::db::Database;
use veloce_desktop_lib::scheduler::Scheduler;
use veloce_desktop_lib::state::AppState;
use veloce_desktop_lib::ws::WsClients;

pub fn test_app_state() -> Arc<AppState> {
    let db = Database::open_in_memory().expect("in-memory db");
    let ws_clients = Arc::new(WsClients::new());
    let handle = tokio::runtime::Handle::current();
    Arc::new(AppState::new(
        db,
        Scheduler::new(Config::from_env()),
        ws_clients,
        handle,
    ))
}
