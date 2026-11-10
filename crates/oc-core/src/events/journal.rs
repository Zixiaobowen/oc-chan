use serde::{Serialize,Deserialize};
use crate::error::{Error,Result,validate_text};
use super::contracts::SAFE_INTEGER;
#[derive(Clone,Debug,Default,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Cursor {pub sequence:u64,pub unconfirmed:bool}
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Cooldown {pub key:String,pub at:i64}
#[derive(Clone,Debug,Default,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Journal {#[serde(deserialize_with="super::contracts::nullable")] pub identity:Option<String>,pub cursor:Cursor,pub summary_count:u64,pub cooldowns:Vec<Cooldown>,pub sent_at:Vec<i64>}
impl Journal {
    pub fn validate(&self)->Result<()> {
        if let Some(id)=&self.identity{validate_text(id,128,512,"notification database identity")?;}
        if self.cursor.sequence>SAFE_INTEGER||self.summary_count>SAFE_INTEGER||self.cooldowns.len()>64||self.sent_at.len()>3{return Err(Error::invalid("notification journal bounds"));}
        let mut seen=std::collections::HashSet::new();for c in &self.cooldowns{if c.key.len()!=64||!c.key.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))||!seen.insert(&c.key)||c.at<0||c.at as u64>SAFE_INTEGER{return Err(Error::invalid("notification cooldown"));}}
        if self.sent_at.iter().any(|at|*at<0||*at as u64>SAFE_INTEGER){return Err(Error::invalid("notification rate time"));}Ok(())
    }
    pub fn suppress(&mut self,count:u64)->Result<()> {self.summary_count=self.summary_count.checked_add(count).filter(|n|*n<=SAFE_INTEGER).ok_or_else(||Error::new("OC_NOTIFICATION_SUMMARY_LIMIT","通知摘要计数已达上限 / Notification summary count exhausted"))?;Ok(())}
    pub fn rebase(&mut self,now:i64,previous:Option<i64>){if let Some(previous)=previous{if now<previous{let delta=now-previous;for at in &mut self.sent_at{*at=(*at+delta).max(0);}for c in &mut self.cooldowns{c.at=(c.at+delta).max(0);}}}else{for at in &mut self.sent_at{*at=(*at).min(now);}for c in &mut self.cooldowns{c.at=c.at.min(now);}}self.sent_at.retain(|at|now-*at<60_000);self.cooldowns.retain(|c|now-c.at<300_000);}
}
#[cfg(test)]mod tests{use super::*;#[test]fn journal_rejects_overflow_and_rebases(){let mut j=Journal::default();j.sent_at=vec![100_000,110_000,120_000];j.cooldowns.push(Cooldown{key:"a".repeat(64),at:100_000});j.rebase(80_000,Some(120_000));assert_eq!(j.sent_at,vec![60_000,70_000,80_000]);assert_eq!(j.cooldowns[0].at,60_000);j.summary_count=SAFE_INTEGER;assert!(j.suppress(1).is_err());assert!(serde_json::from_str::<Journal>("{\"unknown\":1}").is_err());}}
