//! Per-request connection-phase timing (transaction breakdown, opt-in via `measure_phases`).
//!
//! A custom reqwest [`Resolve`] times DNS; a [`tower::Layer`] over the connector times the
//! whole connect (DNS+TCP+TLS). Both write into a `task_local` cell that `execute_step` sets
//! around `send().await` and reads afterward. Installed ONLY when measuring → off = byte-identical.
//!
//! Attribution is approximate: under hyper pool contention a background-spawned connect
//! (`hyper-util client.rs:446`) escapes the task-local. Acceptable for a diagnostic.
use std::cell::Cell;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Instant;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use tower::{Layer, Service};

/// DNS + connect(TCP+TLS) microseconds collected for one request. `0` ⇒ connection reused.
#[derive(Default, Clone, Copy)]
pub struct ConnTiming {
    pub dns_us: u64,
    pub connect_total_us: u64,
}

tokio::task_local! {
    static CONN_TIMING: Cell<ConnTiming>;
}

/// Custom DNS resolver: resolves via `tokio::net::lookup_host` (behaviour-equivalent to the
/// default GAI resolver for explicit hosts) and records the elapsed time into `CONN_TIMING`.
pub struct TimingResolver;

impl Resolve for TimingResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let start = Instant::now();
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let us = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
            let _ = CONN_TIMING.try_with(|c| {
                let mut t = c.get();
                t.dns_us = t.dns_us.saturating_add(us);
                c.set(t);
            });
            let out: Addrs = Box::new(addrs.collect::<Vec<SocketAddr>>().into_iter());
            Ok(out)
        })
    }
}

/// `tower::Layer` that wraps the (crate-private) reqwest connector to time the whole connect.
#[derive(Clone)]
pub struct TimingConnectorLayer;

impl<S> Layer<S> for TimingConnectorLayer {
    type Service = TimingConnector<S>;
    fn layer(&self, inner: S) -> Self::Service {
        TimingConnector { inner }
    }
}

/// Type-opaque connector wrapper — never names reqwest's `Unnameable`/`Conn` (crate-private).
#[derive(Clone)]
pub struct TimingConnector<S> {
    inner: S,
}

impl<S, Req> Service<Req> for TimingConnector<S>
where
    S: Service<Req>,
    S::Future: Send + 'static,
    S::Response: Send,
    S::Error: Send,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<S::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), S::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Req) -> Self::Future {
        let fut = self.inner.call(req);
        let start = Instant::now();
        Box::pin(async move {
            let out = fut.await;
            if out.is_ok() {
                let us = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
                let _ = CONN_TIMING.try_with(|c| {
                    let mut t = c.get();
                    t.connect_total_us = t.connect_total_us.saturating_add(us);
                    c.set(t);
                });
            }
            out
        })
    }
}

/// Build a reqwest builder's resolver+connector instrumentation (only call when measuring).
pub fn install(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .dns_resolver(Arc::new(TimingResolver))
        .connector_layer(TimingConnectorLayer)
}

/// Run `req.send()` inside the timing task-local when `measure` is set, returning the response
/// result and the collected `ConnTiming`. When `measure` is false this is a bare `send()`
/// (no task-local scope) so the off path is byte-identical.
pub async fn send_collecting(
    req: reqwest::RequestBuilder,
    measure: bool,
) -> (reqwest::Result<reqwest::Response>, ConnTiming) {
    if measure {
        CONN_TIMING
            .scope(Cell::new(ConnTiming::default()), async move {
                let r = req.send().await;
                let t = CONN_TIMING.with(|c| c.get());
                (r, t)
            })
            .await
    } else {
        (req.send().await, ConnTiming::default())
    }
}
