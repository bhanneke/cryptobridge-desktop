//! Durable Bisq credentials belong to one canonical node endpoint.
use bdk_wallet::bitcoin::hashes::{sha256, Hash};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Credentials {
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "clientSecret")]
    client_secret: String,
}

fn account(node: &str) -> Result<String, String> {
    let url = url::Url::parse(node).map_err(|e| e.to_string())?;
    if url.path().trim_end_matches('/') != "/api/v1"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("credentials require a canonical /api/v1 node endpoint".into());
    }
    crate::proxy::check_url(
        &format!("{}/settings/version", url.as_str().trim_end_matches('/')),
        crate::proxy::Kind::Http,
    )?;
    Ok(sha256::Hash::hash(url.as_str().trim_end_matches('/').as_bytes()).to_string())
}

fn entry(node: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("io.github.bhanneke.cryptobridge.bisq", &account(node)?)
        .map_err(|e| format!("keychain unavailable: {e}"))
}

#[tauri::command]
pub fn bisq_credentials_load(node: String) -> Result<Option<Credentials>, String> {
    match entry(&node)?.get_password() {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|_| "saved Bisq credentials are invalid; re-pair this node".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read Bisq credentials: {e}")),
    }
}

#[tauri::command]
pub fn bisq_credentials_save(node: String, credentials: Credentials) -> Result<(), String> {
    if credentials.client_id.is_empty() || credentials.client_secret.is_empty() {
        return Err("incomplete Bisq credentials".into());
    }
    entry(&node)?
        .set_password(
            &serde_json::to_string(&credentials).map_err(|_| "could not encode credentials")?,
        )
        .map_err(|e| format!("could not save Bisq credentials: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_is_canonical_and_never_crosses_nodes() {
        assert_eq!(
            account("http://127.0.0.1:8090/api/v1").unwrap(),
            account("http://127.0.0.1:8090/api/v1/").unwrap()
        );
        assert_ne!(
            account("http://127.0.0.1:8090/api/v1").unwrap(),
            account("http://127.0.0.1:8091/api/v1").unwrap()
        );
        assert!(account("http://example.com/api/v1").is_err());
    }
}
