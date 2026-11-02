//! Dispatch to the selected local proxy without changing the route pool.

use std::collections::HashMap;

use apw_core::config::{NetworkSettings, ProxyBackend};
use serde::Serialize;

use crate::{
    clash::{ClashController, GroupNodes},
    surge::SurgeController,
};

pub const MAX_NODE_DELAY_MS: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProbe {
    pub reachable: bool,
    pub delay_ms: Option<u32>,
}

impl NodeProbe {
    pub fn too_slow(self) -> bool {
        self.delay_ms.is_some_and(|delay| delay > MAX_NODE_DELAY_MS)
    }

    pub fn usable(self) -> bool {
        self.reachable && !self.too_slow()
    }

    pub fn unreachable() -> Self {
        Self {
            reachable: false,
            delay_ms: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum ProxyController {
    Clash(ClashController),
    Surge(SurgeController),
}

impl ProxyController {
    pub fn new(network: &NetworkSettings) -> Result<Self, String> {
        match network.backend {
            ProxyBackend::Clash => ClashController::new(&network.clash).map(Self::Clash),
            ProxyBackend::Surge => {
                if !cfg!(target_os = "macos") {
                    return Err("当前平台不支持本地 Surge，请使用 Clash 或跟随系统代理".into());
                }
                SurgeController::new(&network.surge).map(Self::Surge)
            }
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Clash(_) => "Clash",
            Self::Surge(_) => "Surge",
        }
    }

    pub fn restarts_session(&self) -> bool {
        matches!(self, Self::Surge(_))
    }

    pub async fn version(&self) -> Result<String, String> {
        match self {
            Self::Clash(controller) => controller.version().await,
            Self::Surge(controller) => controller.version().await,
        }
    }

    pub async fn group_nodes(&self, group: &str, filter: &str) -> Result<GroupNodes, String> {
        match self {
            Self::Clash(controller) => controller.group_nodes(group, filter).await,
            Self::Surge(controller) => controller.group_nodes(group, filter).await,
        }
    }

    /// Read the current selection without testing nodes or changing the group.
    pub async fn current_node(&self, group: &str) -> Result<Option<String>, String> {
        match self {
            Self::Clash(controller) => controller
                .group_nodes(group, "")
                .await
                .map(|nodes| nodes.now),
            Self::Surge(controller) => controller.selected(group).await.map(Some),
        }
    }

    pub async fn select(&self, group: &str, node: &str) -> Result<(), String> {
        match self {
            Self::Clash(controller) => controller.select(group, node).await,
            Self::Surge(controller) => controller.select(group, node).await,
        }
    }

    pub async fn node_probe(
        &self,
        node: &str,
        provider: Option<&str>,
    ) -> Result<NodeProbe, String> {
        match self {
            // Preserve Clash's existing behavior: an unsuccessful delay test skips
            // the node. Surge distinguishes explicit unreachability from API errors.
            Self::Clash(controller) => Ok(match controller.node_delay(node, provider).await {
                Ok(delay) => NodeProbe {
                    reachable: true,
                    delay_ms: Some(delay),
                },
                Err(_) => NodeProbe::unreachable(),
            }),
            Self::Surge(controller) => controller.node_probe(node).await,
        }
    }

    pub async fn group_probes(
        &self,
        group: &str,
        nodes: &[String],
    ) -> Result<HashMap<String, NodeProbe>, String> {
        match self {
            Self::Clash(controller) => controller.group_delays(group).await.map(|delays| {
                nodes
                    .iter()
                    .map(|name| {
                        (
                            name.clone(),
                            match delays.get(name) {
                                Some(delay) => NodeProbe {
                                    reachable: true,
                                    delay_ms: Some(*delay),
                                },
                                None => NodeProbe::unreachable(),
                            },
                        )
                    })
                    .collect()
            }),
            Self::Surge(controller) => controller.group_probes(group, nodes).await,
        }
    }

    /// Surge connections are discarded by dropping the dedicated Chromium
    /// session. Never call Surge's global request termination endpoints.
    pub async fn close_group_connections(&self, group: &str) -> Result<usize, String> {
        match self {
            Self::Clash(controller) => controller.close_group_connections(group).await,
            Self::Surge(_) => Ok(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_latency_ceiling_is_inclusive_and_does_not_invent_missing_delay() {
        assert!(
            NodeProbe {
                reachable: true,
                delay_ms: Some(500)
            }
            .usable()
        );
        assert!(
            !NodeProbe {
                reachable: true,
                delay_ms: Some(501)
            }
            .usable()
        );
        assert!(
            NodeProbe {
                reachable: true,
                delay_ms: None
            }
            .usable()
        );
        assert!(!NodeProbe::unreachable().usable());
    }
}
