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

fn io_request(total: &Arc<AtomicUsize>, maximum: usize, pending: usize, io: u64) -> HostIo {
    HostIo { generation: 1, call: 1, io, reservation: IoReservation::acquire(total, maximum, pending).unwrap(), cancel: CancellationToken::new() }
}
fn collect_chunk(frame: &[u8], assembly: &mut Reassembly) {
    match serde_json::from_slice::<HostMessage>(frame).unwrap() {
        HostMessage::IoChunk { seq, data, .. } => assembly.push(seq, &data).unwrap(),
        message => panic!("Terminal became visible before task reap: {message:?}"),
    }
}
async fn await_output(ready: oneshot::Receiver<()>, reader: &mut mpsc::Receiver<Vec<u8>>, assembly: &mut Reassembly) {
    tokio::pin!(ready);
    loop {
        tokio::select! {
            result = &mut ready => { result.unwrap(); break; }
            frame = reader.recv() => collect_chunk(&frame.unwrap(), assembly),
        }
    }
    while let Ok(frame) = reader.try_recv() { collect_chunk(&frame, assembly); }
}

#[tokio::test]
async fn io_terminal_waits_for_reap_before_sequential_admission() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let host = crate::io::BoundedIo::new(crate::resources::ResourceBudget::default());
        let total = Arc::new(AtomicUsize::new(0)); let mut ios = JoinSet::new();
        let (writer, mut reader) = mpsc::channel(sdk::WRITE_QUEUE);
        let operations = [
            (sdk::IoOperation::Command { command: sdk::Command::NetworkCounters { interface: "lo0".into() } }, 64 * 1024),
            (sdk::IoOperation::Command { command: sdk::Command::Processes }, sdk::MAX_IO_BYTES),
            (sdk::IoOperation::ResourceStatus, 64 * 1024),
        ];
        for (index, (operation, maximum)) in operations.into_iter().enumerate() {
            let request = io_request(&total, maximum, ios.len(), index as u64 + 1);
            let (ready, observed) = oneshot::channel(); let (release, gate) = oneshot::channel();
            let io = host.clone(); let transfer = writer.clone();
            ios.spawn(async move {
                let completion = request.perform(io, operation, Duration::from_secs(5), transfer, "test".into()).await;
                assert!(completion.1.is_ok());
                ready.send(()).unwrap(); gate.await.unwrap(); completion
            });
            let mut assembly = Reassembly::new(maximum).unwrap();
            await_output(observed, &mut reader, &mut assembly).await;
            // The actual IO has finished, but its supervisor task is held at a
            // deterministic barrier. No terminal may reach the SDK yet.
            assert_eq!(ios.len(), 1); assert_eq!(total.load(Ordering::Acquire), maximum);
            assert!(host.resources().snapshot().global.current == crate::resources::ResourceUsage::default());
            let excess = IoReservation::acquire(&total, sdk::MAX_IO_BYTES, ios.len()).err().unwrap();
            assert_eq!(excess.code, "OC_PLUGIN_PROTOCOL");
            release.send(()).unwrap();
            let completion = ios.join_next().await.unwrap();
            assert!(ios.is_empty()); assert_eq!(total.load(Ordering::Acquire), maximum);
            assert!(matches!(reader.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
            finish_io(completion, &writer).await.unwrap();
            match serde_json::from_slice::<HostMessage>(&reader.recv().await.unwrap()).unwrap() {
                HostMessage::IoEnd { io, bytes, sha256, stdout_bytes, stderr_bytes, data_bytes, .. } => {
                    assert_eq!(io, index as u64 + 1); assert_eq!(bytes, stdout_bytes + stderr_bytes + data_bytes);
                    drop(assembly.finish(bytes, &sha256).unwrap());
                }
                message => panic!("Expected IO completion, received {message:?}"),
            }
            // These are the host admission and ResultEnd predicates at the
            // precise point where the SDK may issue its next message.
            assert_eq!(total.load(Ordering::Acquire), 0); assert!(ios.is_empty());
        }
        host.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn io_success_completed_before_cancellation_preserves_its_outcome() {
    let host = crate::io::BoundedIo::new(crate::resources::ResourceBudget::default());
    let total = Arc::new(AtomicUsize::new(0)); let mut ios = JoinSet::new();
    let (writer, mut reader) = mpsc::channel(sdk::WRITE_QUEUE);
    let request = io_request(&total, 64 * 1024, ios.len(), 1); let cancel = request.cancel.clone();
    let (ready, observed) = oneshot::channel(); let (release, gate) = oneshot::channel();
    let io = host.clone(); let transfer = writer.clone();
    ios.spawn(async move {
        let completion = request.perform(io, sdk::IoOperation::ResourceStatus, Duration::from_secs(5), transfer, "test".into()).await;
        assert!(completion.1.is_ok()); ready.send(()).unwrap(); gate.await.unwrap(); completion
    });
    await_output(observed, &mut reader, &mut Reassembly::new(64 * 1024).unwrap()).await;
    cancel.cancel(); release.send(()).unwrap();
    finish_io(ios.join_next().await.unwrap(), &writer).await.unwrap();
    assert!(matches!(serde_json::from_slice::<HostMessage>(&reader.recv().await.unwrap()).unwrap(), HostMessage::IoEnd { .. }));
    assert!(matches!(reader.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    assert_eq!(total.load(Ordering::Acquire), 0); assert!(ios.is_empty());
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn io_cleanup_failure_survives_cancellation_and_terminal_delivery_failure() {
    for disconnected in [false, true] {
        let host = crate::io::BoundedIo::new(crate::resources::ResourceBudget::default());
        let total = Arc::new(AtomicUsize::new(0)); let mut ios = JoinSet::new();
        let (writer, reader) = mpsc::channel(sdk::WRITE_QUEUE); let mut reader = Some(reader);
        let request = io_request(&total, 64 * 1024, ios.len(), 1); let cancel = request.cancel.clone();
        let (ready, observed) = oneshot::channel(); let (release, gate) = oneshot::channel();
        let io = host.clone();
        ios.spawn(async move {
            let result = io.with_file_budget("test", 64 * 1024, &request.cancel, move |cancel| async move {
                ready.send(()).unwrap(); cancel.cancelled().await; gate.await.unwrap();
                Err::<HostMessage, _>(Error::cleanup("test close", Error::io("close", std::io::Error::from_raw_os_error(libc::EIO))))
            }).await;
            (request, result)
        });
        observed.await.unwrap(); cancel.cancel();
        assert_eq!(total.load(Ordering::Acquire), 64 * 1024);
        assert!(matches!(reader.as_mut().unwrap().try_recv(), Err(mpsc::error::TryRecvError::Empty)));
        if disconnected { drop(reader.take()); }
        release.send(()).unwrap();
        let error = finish_io(ios.join_next().await.unwrap(), &writer).await.unwrap_err();
        assert!(error.is_cleanup());
        let cleanup = if disconnected { assert_eq!(error.causes.len(), 2); &error.causes[0] } else { &error };
        assert_eq!(cleanup.causes[0].os_error, Some(libc::EIO));
        if let Some(mut reader) = reader {
            assert!(matches!(serde_json::from_slice::<HostMessage>(&reader.recv().await.unwrap()).unwrap(), HostMessage::IoError { code: ErrorCode::Cleanup, .. }));
            assert!(matches!(reader.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
        }
        assert_eq!(total.load(Ordering::Acquire), 0); assert!(ios.is_empty());
        assert!(host.resources().snapshot().global.current == crate::resources::ResourceUsage::default());
        host.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn io_concurrent_slot_limit_remains_enforced_until_reap() {
    let total = Arc::new(AtomicUsize::new(0)); let mut ios = JoinSet::new();
    let (writer, mut reader) = mpsc::channel(sdk::WRITE_QUEUE); let mut releases = Vec::new();
    for index in 0..sdk::MAX_IO {
        let request = io_request(&total, 64 * 1024, ios.len(), index as u64 + 1);
        let (release, gate) = oneshot::channel(); releases.push(release);
        ios.spawn(async move { gate.await.unwrap(); (request, Err(Error::cancelled())) });
    }
    assert_eq!(IoReservation::acquire(&total, 64 * 1024, ios.len()).err().unwrap().code, "OC_PLUGIN_PROTOCOL");
    assert_eq!(total.load(Ordering::Acquire), sdk::MAX_IO * 64 * 1024);
    for release in releases { release.send(()).unwrap(); }
    while let Some(completion) = ios.join_next().await {
        finish_io(completion, &writer).await.unwrap();
        assert!(matches!(serde_json::from_slice::<HostMessage>(&reader.recv().await.unwrap()).unwrap(), HostMessage::IoError { code: ErrorCode::Cancelled, .. }));
    }
    assert_eq!(total.load(Ordering::Acquire), 0);
    let next = IoReservation::acquire(&total, sdk::MAX_IO_BYTES, ios.len()).unwrap();
    drop(next); assert_eq!(total.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn io_cancelled_before_execution_reaps_before_error_terminal() {
    let host = crate::io::BoundedIo::new(crate::resources::ResourceBudget::default());
    let total = Arc::new(AtomicUsize::new(0)); let mut ios = JoinSet::new();
    let (writer, mut reader) = mpsc::channel(1);
    let request = io_request(&total, 64 * 1024, ios.len(), 1); let cancel = request.cancel.clone();
    cancel.cancel();
    let (ready, observed) = oneshot::channel(); let (release, gate) = oneshot::channel();
    let io = host.clone(); let transfer = writer.clone();
    ios.spawn(async move {
        let completion = request.perform(io, sdk::IoOperation::ResourceStatus, Duration::from_secs(5), transfer, "test".into()).await;
        assert!(completion.1.as_ref().err().unwrap().is_cancelled());
        ready.send(()).unwrap(); gate.await.unwrap(); completion
    });
    await_output(observed, &mut reader, &mut Reassembly::new(64 * 1024).unwrap()).await;
    assert_eq!(total.load(Ordering::Acquire), 64 * 1024); assert_eq!(ios.len(), 1);
    release.send(()).unwrap();
    finish_io(ios.join_next().await.unwrap(), &writer).await.unwrap();
    assert!(matches!(serde_json::from_slice::<HostMessage>(&reader.recv().await.unwrap()).unwrap(), HostMessage::IoError { code: ErrorCode::Cancelled, .. }));
    assert!(matches!(reader.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
    assert_eq!(total.load(Ordering::Acquire), 0); assert!(ios.is_empty());
    host.shutdown().await.unwrap();
}
