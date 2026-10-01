//! Single-writer fixture store. One fsynced atomic image contains journal head/frames/rows.
//! It is a host test capability, never a second command or data semantic port.
use rhizomatic::ordinary_journal_peer::{
    AdmittedRowRead, DurableOrdinaryJournalStore, ErasureJournalWrite, OrdinaryJournalHead,
    OrdinaryJournalRead,
};
use rhizomatic::single_peer::PeerImageWrite;
use rhizomatic::types::Delta;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub struct DiskJournal {
    path: PathBuf,
    pub fault: Option<String>,
    pub before_append: Option<Box<dyn FnMut() -> Result<(), String>>>,
}
impl DiskJournal {
    pub fn new(path: &str, fault: Option<String>) -> Self {
        Self {
            path: PathBuf::from(path),
            fault,
            before_append: None,
        }
    }
    pub fn image(&self) -> Result<Value, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(json!({"head":null,"frames":[],"rows":[],"checkpoint":null}))
            }
            Err(e) => Err(e.to_string()),
        }
    }
    fn persist(&self, image: &Value) -> Result<(), String> {
        let parent = self.path.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&serde_json::to_vec(image).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&self.path).map_err(|e| e.to_string())?;
        fs::File::open(parent)
            .and_then(|d| d.sync_all())
            .map_err(|e| e.to_string())
    }
    fn append_image(
        &self,
        image: &mut Value,
        next: &str,
        frame: Option<&[u8]>,
        rows: &[Delta],
    ) -> Result<(), String> {
        image["head"] = json!(next);
        if let Some(frame) = frame {
            image["frames"]
                .as_array_mut()
                .ok_or("frames array")?
                .push(json!(hex::encode(frame)));
        }
        for row in rows {
            if !image["rows"]
                .as_array()
                .ok_or("rows array")?
                .iter()
                .any(|v| v["id"] == row.id)
            {
                image["rows"]
                    .as_array_mut()
                    .unwrap()
                    .push(super::debug(row));
            }
        }
        self.persist(image)
    }
}
impl DurableOrdinaryJournalStore for DiskJournal {
    fn read_journal(&self, _peer: &str) -> Result<OrdinaryJournalRead, String> {
        if self.fault.as_deref() == Some("store-unavailable") {
            return Err("injected store unavailable".into());
        }
        let image = self.image()?;
        let Some(head) = image["head"].as_str() else {
            return Ok(
                if image["rows"].as_array().ok_or("rows array")?.is_empty() {
                    OrdinaryJournalRead::Empty
                } else {
                    OrdinaryJournalRead::RowsWithoutJournal
                },
            );
        };
        let frames = image["frames"]
            .as_array()
            .ok_or("frames array")?
            .iter()
            .map(|v| hex::decode(v.as_str().ok_or("frame hex")?).map_err(|e| e.to_string()))
            .collect::<Result<_, String>>()?;
        let checkpoint = image["checkpoint"]
            .as_str()
            .map(hex::decode)
            .transpose()
            .map_err(|e| e.to_string())?;
        Ok(OrdinaryJournalRead::Journal {
            head: head.into(),
            frames,
            checkpoint,
        })
    }
    fn read_admitted_rows(&self, _peer: &str, ids: &[String]) -> Result<Vec<Delta>, String> {
        let image = self.image()?;
        image["rows"]
            .as_array()
            .ok_or("rows array")?
            .iter()
            .filter(|v| {
                v["id"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|wanted| wanted == id))
            })
            .map(super::delta)
            .collect()
    }
    fn read_admitted_rows_degraded(
        &self,
        _peer: &str,
        ids: &[String],
    ) -> Result<Vec<AdmittedRowRead>, String> {
        let image = self.image()?;
        let rows = image["rows"].as_array().ok_or("rows array")?;
        Ok(ids
            .iter()
            .map(|id| {
                let parsed = rows
                    .iter()
                    .find(|v| v["id"] == *id)
                    .map(super::delta)
                    .transpose();
                match parsed {
                    Ok(row) => AdmittedRowRead {
                        id: id.clone(),
                        row,
                        fault: None,
                    },
                    Err(fault) => AdmittedRowRead {
                        id: id.clone(),
                        row: None,
                        fault: Some(fault),
                    },
                }
            })
            .collect())
    }
    fn read_head(&self, _peer: &str) -> Result<OrdinaryJournalHead, String> {
        if self.fault.as_deref() == Some("source-changed") {
            return Ok(OrdinaryJournalHead::Head(format!(
                "1e20{}",
                "ff".repeat(32)
            )));
        }
        Ok(self.image()?["head"]
            .as_str()
            .map(|s| OrdinaryJournalHead::Head(s.into()))
            .unwrap_or(OrdinaryJournalHead::Missing))
    }
    fn compare_and_append(
        &mut self,
        _peer: &str,
        expected: Option<&str>,
        next: &str,
        frame: Option<&[u8]>,
        rows: &[Delta],
    ) -> Result<PeerImageWrite, String> {
        if frame.is_some() {
            if let Some(mut hook) = self.before_append.take() {
                hook()?;
            }
        }
        let mut image = self.image()?;
        if image["head"].as_str() != expected
            || (expected.is_none() && !image["rows"].as_array().ok_or("rows array")?.is_empty())
        {
            return Ok(PeerImageWrite::Conflict);
        }
        let fault = if frame.is_some() {
            self.fault.take()
        } else {
            None
        };
        match fault.as_deref() {
            Some("conflict") => return Ok(PeerImageWrite::Conflict),
            Some("crash-before-append") => std::process::exit(77),
            Some("committed-unconfirmed-absent") => {
                return Ok(PeerImageWrite::CommittedUnconfirmed {
                    fault: "injected uncertain acknowledgment without persisted append".into(),
                })
            }
            Some("append-error-absent") => return Err("injected unknown append error".into()),
            _ => {}
        }
        self.append_image(&mut image, next, frame, rows)?;
        match fault.as_deref() {
            Some("crash-after-append") => std::process::exit(77),
            Some("committed-unconfirmed-persist") => Ok(PeerImageWrite::CommittedUnconfirmed {
                fault: "injected acknowledgment loss after durable append".into(),
            }),
            Some("append-error-persist") => {
                Err("injected unknown acknowledgment error after durable append".into())
            }
            _ => Ok(PeerImageWrite::Durable),
        }
    }
    fn compare_and_append_erasure(
        &mut self,
        peer: &str,
        expected: &str,
        next: &str,
        frame: &[u8],
        rows: &[Delta],
        absent: &[String],
    ) -> Result<ErasureJournalWrite, String> {
        let image = self.image()?;
        if let Some(id) = absent.iter().find(|id| {
            image["rows"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|row| row["id"].as_str() == Some(id.as_str()))
            })
        }) {
            return Ok(ErasureJournalWrite::AbsenceRefuted {
                target_id: id.clone(),
            });
        }
        self.compare_and_append(peer, Some(expected), next, Some(frame), rows)
            .map(Into::into)
    }
}
