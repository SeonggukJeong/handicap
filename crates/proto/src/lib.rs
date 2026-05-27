#![allow(clippy::all)]

pub mod coordinator {
    pub mod v1 {
        tonic::include_proto!("handicap.coordinator.v1");
    }
}

pub use coordinator::v1;
