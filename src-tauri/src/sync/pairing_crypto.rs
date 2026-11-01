//! Key agreement for device pairing: X25519 with a short code both users compare.
//! The initiator commits to its public key before seeing the responder's, so an
//! attacker in the middle cannot search for keys that produce matching codes.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

const COMMIT_LABEL: &[u8] = b"shellbeam-pair-commit-v1";
const TRANSCRIPT_LABEL: &[u8] = b"shellbeam-pair-transcript-v1";

pub(crate) struct KeyPair {
    secret: StaticSecret,
    pub public: [u8; 32],
}

pub(crate) struct PairingDevice<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub public: &'a [u8; 32],
}

#[derive(Clone)]
pub(crate) struct PairingSecrets {
    pub sync_key: [u8; 32],
    pub code: String,
    confirm_key: [u8; 32],
}

pub(crate) fn generate_keypair() -> KeyPair {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let secret = StaticSecret::from(bytes);
    let public = PublicKey::from(&secret).to_bytes();
    KeyPair { secret, public }
}

pub(crate) fn commitment(public: &[u8; 32]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(COMMIT_LABEL);
    hash.update(public);
    hash.finalize().into()
}

fn update_field(hash: &mut Sha256, field: &[u8]) {
    hash.update((field.len() as u64).to_be_bytes());
    hash.update(field);
}

/// Both sides call this with the same `initiator` and `responder`. The device
/// names and ids are in the transcript, so changing them changes the code.
pub(crate) fn derive_secrets(
    own: &KeyPair,
    peer_public: &[u8; 32],
    initiator: &PairingDevice<'_>,
    responder: &PairingDevice<'_>,
) -> Result<PairingSecrets, String> {
    let shared = own.secret.diffie_hellman(&PublicKey::from(*peer_public));
    if !shared.was_contributory() {
        return Err("Invalid pairing public key".to_string());
    }
    let mut hash = Sha256::new();
    hash.update(TRANSCRIPT_LABEL);
    for device in [initiator, responder] {
        update_field(&mut hash, device.id.as_bytes());
        update_field(&mut hash, device.name.as_bytes());
        update_field(&mut hash, device.public);
    }
    let transcript = hash.finalize();
    let hkdf = Hkdf::<Sha256>::new(Some(&transcript), shared.as_bytes());

    let mut sync_key = [0u8; 32];
    let mut confirm_key = [0u8; 32];
    let mut code_bytes = [0u8; 8];
    for (label, output) in [
        (&b"sync-key"[..], &mut sync_key[..]),
        (&b"confirm-key"[..], &mut confirm_key[..]),
        (&b"code"[..], &mut code_bytes[..]),
    ] {
        hkdf.expand(label, output)
            .map_err(|e| format!("derive pairing key: {e}"))?;
    }
    Ok(PairingSecrets {
        sync_key,
        code: format!("{:06}", u64::from_be_bytes(code_bytes) % 1_000_000),
        confirm_key,
    })
}

fn confirmation_mac(secrets: &PairingSecrets, session_id: &str) -> Hmac<Sha256> {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(&secrets.confirm_key).expect("HMAC accepts any key");
    mac.update(session_id.as_bytes());
    mac
}

/// Proof the responder's user accepted: only a holder of the derived keys can make it.
pub(crate) fn confirmation_proof(secrets: &PairingSecrets, session_id: &str) -> Vec<u8> {
    confirmation_mac(secrets, session_id)
        .finalize()
        .into_bytes()
        .to_vec()
}

pub(crate) fn verify_confirmation(
    secrets: &PairingSecrets,
    session_id: &str,
    proof: &[u8],
) -> bool {
    confirmation_mac(secrets, session_id)
        .verify_slice(proof)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device<'a>(id: &'a str, public: &'a [u8; 32]) -> PairingDevice<'a> {
        PairingDevice {
            id,
            name: "name",
            public,
        }
    }

    #[test]
    fn both_sides_derive_the_same_secrets() {
        let (a, b) = (generate_keypair(), generate_keypair());
        let left = derive_secrets(
            &a,
            &b.public,
            &device("a", &a.public),
            &device("b", &b.public),
        );
        let right = derive_secrets(
            &b,
            &a.public,
            &device("a", &a.public),
            &device("b", &b.public),
        );
        let (left, right) = (left.unwrap(), right.unwrap());
        assert_eq!(left.sync_key, right.sync_key);
        assert_eq!(left.code, right.code);
        assert_eq!(left.code.len(), 6);
        assert!(verify_confirmation(
            &left,
            "session",
            &confirmation_proof(&right, "session")
        ));
    }

    #[test]
    fn an_attacker_in_the_middle_holds_different_keys() {
        let (a, b, attacker) = (generate_keypair(), generate_keypair(), generate_keypair());
        let with_a = derive_secrets(
            &a,
            &attacker.public,
            &device("a", &a.public),
            &device("b", &attacker.public),
        )
        .unwrap();
        let with_b = derive_secrets(
            &b,
            &attacker.public,
            &device("a", &attacker.public),
            &device("b", &b.public),
        )
        .unwrap();
        assert_ne!(with_a.sync_key, with_b.sync_key);
        assert!(!verify_confirmation(
            &with_a,
            "session",
            &confirmation_proof(&with_b, "session")
        ));
    }

    #[test]
    fn changing_a_device_id_changes_the_keys() {
        let (a, b) = (generate_keypair(), generate_keypair());
        let real = derive_secrets(
            &a,
            &b.public,
            &device("a", &a.public),
            &device("b", &b.public),
        );
        let forged = derive_secrets(
            &b,
            &a.public,
            &device("x", &a.public),
            &device("b", &b.public),
        );
        assert_ne!(real.unwrap().sync_key, forged.unwrap().sync_key);
    }

    #[test]
    fn a_low_order_public_key_is_rejected() {
        let a = generate_keypair();
        let zero = [0u8; 32];
        let result = derive_secrets(&a, &zero, &device("a", &a.public), &device("b", &zero));
        assert!(result.is_err());
    }

    #[test]
    fn a_wrong_session_fails_confirmation() {
        let (a, b) = (generate_keypair(), generate_keypair());
        let secrets = derive_secrets(
            &a,
            &b.public,
            &device("a", &a.public),
            &device("b", &b.public),
        )
        .unwrap();
        assert!(!verify_confirmation(
            &secrets,
            "other",
            &confirmation_proof(&secrets, "session")
        ));
    }
}
