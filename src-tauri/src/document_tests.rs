use super::*;

fn document() -> Document {
    let document = Document::new(1, View::Main, 0, "document-key".into(), true, None);
    document.ready.store(true, Ordering::Release);
    document.listening.store(true, Ordering::Release);
    document.interest.lock().unwrap().monitor = true;
    document
}
fn value(delivery: &Delivery) -> serde_json::Value { serde_json::from_str::<serde_json::Value>(&delivery.payload).unwrap()["value"].clone() }

#[test]
fn slow_renderer_keeps_latest_value_per_partition_and_duplicate_ack_keeps_credit_owned() {
    let document = document();
    assert_eq!(value(&document.push("monitor-changed", "agents", Arc::from("0")).unwrap().unwrap()), 0);
    document.push("monitor-changed", "schedules", Arc::from("1")).unwrap();
    for revision in 1..=100 { assert!(document.push("monitor-changed", "agents", Arc::from(revision.to_string())).unwrap().is_none()); }
    document.push("monitor-changed", "schedules", Arc::from("2")).unwrap();
    assert_eq!(document.outbound.lock().unwrap().pending.len(), 2);
    assert_eq!(value(&document.acknowledge(1).unwrap().unwrap()), 2);
    assert!(document.acknowledge(1).unwrap().is_none());
    assert!(document.acknowledge(3).is_err());
    assert_eq!(value(&document.acknowledge(2).unwrap().unwrap()), 100);
    assert!(document.acknowledge(3).unwrap().is_none());
    assert_eq!(document.outbound.lock().unwrap().bytes, 0);
    assert!(document.acknowledge(0).is_err());
}

#[test]
fn failed_delivery_never_replays_an_older_queued_partition_after_its_new_value() {
    let document = document();
    document.push("monitor-changed", "agents", Arc::from("0")).unwrap();
    document.push("monitor-changed", "agents", Arc::from("1")).unwrap();
    document.failed_delivery().unwrap();
    assert_eq!(value(&document.push("monitor-changed", "agents", Arc::from("2")).unwrap().unwrap()), 2);
    assert!(document.acknowledge(2).unwrap().is_none());
    assert_eq!(document.outbound.lock().unwrap().bytes, 0);
}

#[test]
fn byte_limit_rejects_before_mutating_retained_updates_and_pause_drops_pending() {
    let document = document();
    document.push("monitor-changed", "agents", Arc::from("null")).unwrap();
    let payload: Arc<str> = format!("\"{}\"", "x".repeat(8 * 1024 * 1024 - 128 - 2)).into();
    document.push("monitor-changed", "agents", payload.clone()).unwrap();
    document.push("monitor-changed", "schedules", payload).unwrap();
    assert!(document.push("monitor-changed", "system", format!("\"{}\"", "x".repeat(512)).into()).is_err());
    { let outbound = document.outbound.lock().unwrap(); assert_eq!(outbound.pending.len(), 2); assert_eq!(outbound.bytes, 16 * 1024 * 1024 - 256); }
    document.pause_pushes().unwrap();
    assert!(document.acknowledge(1).unwrap().is_none());
    let outbound = document.outbound.lock().unwrap(); assert_eq!(outbound.bytes, 0); assert!(outbound.pending.is_empty());
}

#[test]
fn unsubscribe_and_revoke_stop_old_document_deliveries() {
    let book = Documents::default();
    let (owner, epoch) = book.allocate(View::Main).unwrap();
    let first = Arc::new(Document::new(owner, View::Main, epoch, "key".into(), true, None));
    first.ready.store(true, Ordering::Release); first.listening.store(true, Ordering::Release);
    first.interest.lock().unwrap().monitor = true;
    book.insert(first.clone()).unwrap();
    assert!(book.current(View::Main, owner, "key").is_ok());
    first.push("monitor-changed", "agents", Arc::from("1")).unwrap();
    first.push("monitor-changed", "agents", Arc::from("2")).unwrap();
    first.interest.lock().unwrap().monitor = false;
    assert!(first.acknowledge(1).unwrap().is_none());
    book.invalidate(View::Main).unwrap();
    assert!(!first.can_receive("desktop-failure", true).unwrap());
    assert!(book.current(View::Main, owner, "key").is_err());
    book.take(View::Main).unwrap();
    let (next, epoch) = book.allocate(View::Main).unwrap();
    let second = Arc::new(Document::new(next, View::Main, epoch, "key".into(), true, None));
    second.ready.store(true, Ordering::Release); book.insert(second).unwrap();
    assert!(book.current(View::Main, next, "key").is_ok());
    assert!(book.current(View::Main, owner, "key").is_err());
    assert!(book.current(View::Tray, next, "key").is_err());
}

#[tokio::test]
async fn replaced_query_drains_previous_work_before_starting_next() {
    let slot = Arc::new(QuerySlot::default()); let parent = CancellationToken::new();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (released, mut drained) = tokio::sync::oneshot::channel();
    let first_slot = slot.clone(); let first_parent = parent.clone();
    let first = tokio::spawn(async move { first_slot.run(&first_parent, |cancel| async move {
        started.send(()).unwrap(); cancel.cancelled().await; released.send(()).unwrap(); Err::<(), _>(Error::cancelled())
    }).await });
    ready.await.unwrap();
    slot.run(&parent, |_| async move { drained.try_recv().expect("prior query has released its work"); Ok(()) }).await.unwrap();
    assert!(first.await.unwrap().unwrap_err().is_cancelled());
    slot.cancel().await.unwrap();
}
