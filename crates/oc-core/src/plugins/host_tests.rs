use super::*;

#[tokio::test]
async fn frame_reader_rejects_unterminated_and_oversized_frames() {
    let (mut writer, reader) = tokio::io::duplex(128);
    let send = tokio::spawn(async move { let _result = writer.write_all(&vec![b'x'; sdk::MAX_FRAME + 1]).await; });
    let mut reader = BufReader::with_capacity(64, reader);
    assert!(read_frame(&mut reader).await.is_err()); drop(reader); send.await.unwrap();
    let (mut writer, reader) = tokio::io::duplex(128);
    writer.write_all(br#"{"type":"stopped","v":2,"generation":1}"#).await.unwrap(); drop(writer);
    assert!(read_frame(&mut BufReader::new(reader)).await.is_err());
}
#[tokio::test]
async fn frame_reader_accepts_split_valid_message_and_rejects_unknown_keys() {
    let (mut writer, reader) = tokio::io::duplex(16);
    let send = tokio::spawn(async move {
        for part in b"{\"type\":\"stopped\",\"v\":2,\"generation\":1}\n".chunks(3) { writer.write_all(part).await.unwrap(); }
    });
    let message = read_frame(&mut BufReader::with_capacity(8, reader)).await.unwrap().unwrap(); message.validate(Some(1)).unwrap(); assert!(message.validate(Some(2)).is_err()); send.await.unwrap();
    let (mut writer, reader) = tokio::io::duplex(128);
    writer.write_all(b"{\"type\":\"stopped\",\"v\":2,\"generation\":1,\"extra\":1}\n").await.unwrap();
    assert!(read_frame(&mut BufReader::new(reader)).await.is_err());
}

#[tokio::test]
async fn backpressure_reserves_slot_before_constructing_a_frame() {
    let (writer, mut reader) = mpsc::channel(1);
    send(&writer, HostMessage::Stop { v: VERSION, generation: 1 }).await.unwrap();
    let allocations = Arc::new(AtomicUsize::new(0)); let count = allocations.clone();
    let queued = tokio::spawn(async move { enqueue(&writer, move || { count.fetch_add(1, Ordering::SeqCst); Ok(HostMessage::Stop { v: VERSION, generation: 1 }) }).await });
    tokio::task::yield_now().await;
    assert_eq!(allocations.load(Ordering::SeqCst), 0); assert!(!queued.is_finished());
    reader.recv().await.unwrap(); queued.await.unwrap().unwrap(); assert_eq!(allocations.load(Ordering::SeqCst), 1);
}
