//! Surge HTTP API adapter. Only the configured select group is changed.
//!
//! API contract: https://manual.nssurge.com/tools/http-api.html
//! Group members are the selection tokens returned by policy_groups; external
//! POLICY:: identifiers are deliberately not substituted for those tokens.

use std::{collections::HashMap, time::Duration};

use apw_core::config::SurgeSettings;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    clash::{DELAY_TEST_URL, GroupNodes},
    proxy_controller::NodeProbe,
};

#[derive(Debug, Clone)]
pub struct SurgeController {
    http: reqwest::Client,
    base: reqwest::Url,
    secret: String,
    group: String,
}

impl SurgeController {
    pub fn new(settings: &SurgeSettings) -> Result<Self, String> {
        let base = reqwest::Url::parse(&settings.controller)
            .map_err(|_| "Surge 控制接口地址无效".to_string())?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err("Surge 控制接口地址需以 http:// 或 https:// 开头".into());
        }
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(4))
            .build()
            .map_err(|e| format!("无法创建 Surge 控制接口客户端：{e}"))?;
        Ok(Self {
            http,
            base,
            secret: settings.secret.clone(),
            group: settings.group.clone(),
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut url = self.base.clone();
        url.set_path(&format!(
            "{}/v1/{path}",
            self.base.path().trim_end_matches('/')
        ));
        self.http.request(method, url).header("X-Key", &self.secret)
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, String> {
        let response = request
            .send()
            .await
            .map_err(|e| format!("无法连接 Surge 控制接口：{}", e.without_url()))?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => return Err("Surge 控制接口拒绝访问，请检查 API 密钥".into()),
            404 => return Err("Surge 控制接口找不到该资源，请检查接口地址和策略组".into()),
            status => return Err(format!("Surge 控制接口返回 HTTP {status}")),
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Surge 控制接口返回的 JSON 无法解析".to_string())?;
        if value
            .get("error")
            .is_some_and(|error| !error.is_null() && error != false)
        {
            return Err("Surge 控制接口报告错误，请检查策略组与节点配置".into());
        }
        Ok(value)
    }

    pub async fn ensure_rule_mode(&self) -> Result<(), String> {
        let value = self
            .send(self.request(reqwest::Method::GET, "outbound"))
            .await?;
        match value.get("mode").and_then(Value::as_str) {
            Some("rule") => Ok(()),
            Some(_) => Err("Surge 当前不是规则模式，请在 Surge 中切换到规则模式后重试".into()),
            None => Err("Surge 出站模式响应无法识别".into()),
        }
    }

    pub async fn version(&self) -> Result<String, String> {
        self.ensure_rule_mode().await?;
        let value = self
            .send(self.request(reqwest::Method::GET, "policies"))
            .await?;
        if !value.get("proxies").is_some_and(Value::is_array) {
            return Err("Surge 策略列表响应无法识别".into());
        }
        // This endpoint establishes connectivity, not a kernel version.
        Ok("Surge HTTP API（已连接）".into())
    }

    pub(crate) async fn selected(&self, group: &str) -> Result<String, String> {
        let value = self
            .send(
                self.request(reqwest::Method::GET, "policy_groups/select")
                    .query(&[("group_name", group)]),
            )
            .await?;
        value
            .get("policy")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Surge 未返回 select 策略组的当前节点".into())
    }

    pub async fn group_nodes(&self, group: &str, filter: &str) -> Result<GroupNodes, String> {
        self.ensure_rule_mode().await?;
        let value = self
            .send(self.request(reqwest::Method::GET, "policy_groups"))
            .await?;
        let mut nodes = parse_group_nodes(&value, group, filter)?;
        // The select endpoint also rejects non-select groups, without changing them.
        nodes.now = Some(self.selected(group).await?);
        Ok(nodes)
    }

    pub async fn select(&self, group: &str, node: &str) -> Result<(), String> {
        self.ensure_rule_mode().await?;
        self.send(
            self.request(reqwest::Method::POST, "policy_groups/select")
                .json(&json!({"group_name": group, "policy": node})),
        )
        .await?;
        if self.selected(group).await? != node {
            return Err("Surge 未确认目标节点已选中，请检查外部节点名称及策略组配置".into());
        }
        Ok(())
    }

    pub async fn node_probe(&self, node: &str) -> Result<NodeProbe, String> {
        self.probe_nodes(&self.group, &[node.to_string()])
            .await?
            .get(node)
            .copied()
            .ok_or_else(|| "Surge 未返回目标节点的连通性结果".into())
    }

    pub async fn group_probes(
        &self,
        group: &str,
        nodes: &[String],
    ) -> Result<HashMap<String, NodeProbe>, String> {
        self.probe_nodes(group, nodes).await
    }

    async fn probe_nodes(
        &self,
        group: &str,
        nodes: &[String],
    ) -> Result<HashMap<String, NodeProbe>, String> {
        let groups = self
            .send(self.request(reqwest::Method::GET, "policy_groups"))
            .await?;
        let members = group_members(&groups, group)?;
        let mut targets = Vec::new();
        for name in nodes.iter().filter(|name| name.as_str() != "DIRECT") {
            let member = members
                .iter()
                .find(|member| member.name() == name)
                .ok_or_else(|| format!("节点「{name}」已不在 Surge 专用策略组中"))?;
            if !member.enabled_route() {
                return Err(format!("节点「{name}」已停用或属于嵌套策略组"));
            }
            targets.push((name.clone(), member.probe_token().to_string()));
        }
        if targets.is_empty() {
            return Ok(HashMap::new());
        }
        // Verified on Surge Mac 6.10: external members require lineHash for
        // /policies/test, but /policy_groups/select still requires the name.
        // /policy_groups/test on a select group only tested its current choice.
        let value = self.send(self.request(reqwest::Method::POST, "policies/test")
            .timeout(Duration::from_secs(30))
            .json(&json!({"policy_names": targets.iter().map(|(_, token)| token).collect::<Vec<_>>(), "url": DELAY_TEST_URL}))).await?;
        let probes = parse_probes(&value)?;
        let complete = value.get("available").is_some_and(Value::is_array);
        Ok(targets
            .into_iter()
            .filter_map(|(name, token)| {
                probes
                    .get(&name)
                    .or_else(|| probes.get(&token))
                    .copied()
                    .or_else(|| complete.then(NodeProbe::unreachable))
                    .map(|probe| (name, probe))
            })
            .collect())
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Member {
    Name(String),
    Detail {
        name: String,
        #[serde(rename = "typeDescription", alias = "type", default)]
        kind: String,
        #[serde(rename = "isGroup", default)]
        is_group: bool,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(rename = "lineHash", default)]
        line_hash: Option<String>,
    },
}

fn enabled_by_default() -> bool {
    true
}

impl Member {
    fn name(&self) -> &str {
        match self {
            Self::Name(name) | Self::Detail { name, .. } => name,
        }
    }

    fn enabled_route(&self) -> bool {
        !matches!(
            self,
            Self::Detail { is_group: true, .. } | Self::Detail { enabled: false, .. }
        )
    }

    fn probe_token(&self) -> &str {
        match self {
            Self::Detail {
                line_hash: Some(token),
                ..
            } if !token.is_empty() => token,
            _ => self.name(),
        }
    }
}

fn group_members(value: &Value, group: &str) -> Result<Vec<Member>, String> {
    let groups = value.as_object().ok_or("Surge 策略组响应无法识别")?;
    let entries = groups
        .get(group)
        .ok_or_else(|| format!("Surge 中没有名为「{group}」的策略组"))?;
    serde_json::from_value(entries.clone()).map_err(|_| "Surge 策略组成员响应无法识别".to_string())
}

fn parse_group_nodes(value: &Value, group: &str, filter: &str) -> Result<GroupNodes, String> {
    let members = group_members(value, group)?;
    let keywords: Vec<_> = filter
        .split('|')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let total = members.len();
    let mut nodes = Vec::new();
    for member in members {
        if !member.enabled_route() {
            continue;
        }
        let (name, kind) = match member {
            Member::Name(name) => (name, String::new()),
            Member::Detail { name, kind, .. } => (name, kind.to_lowercase()),
        };
        let lower = name.to_lowercase();
        if name.is_empty()
            || value.get(&name).is_some()
            || lower.starts_with("reject")
            || name == "REJECT-DROP"
            || matches!(
                kind.as_str(),
                "select"
                    | "url-test"
                    | "fallback"
                    | "load-balance"
                    | "smart"
                    | "relay"
                    | "reject"
                    | "reject-drop"
                    | "reject-no-drop"
                    | "reject-tinygif"
            )
            || [
                "剩余", "到期", "过期", "官网", "重置", "套餐", "网址", "expire", "traffic",
            ]
            .iter()
            .any(|s| lower.contains(s))
            || (!keywords.is_empty() && !keywords.iter().any(|s| lower.contains(s)))
            || nodes.contains(&name)
        {
            continue;
        }
        nodes.push(name);
    }
    Ok(GroupNodes {
        now: None,
        skipped: total - nodes.len(),
        nodes,
        providers: HashMap::new(),
    })
}

/// Recognize explicit availability only. A successful HTTP call or missing delay
/// alone is not evidence that a node is reachable.
fn parse_probes(value: &Value) -> Result<HashMap<String, NodeProbe>, String> {
    if let Some(available) = value.get("available").filter(|value| value.is_array()) {
        let names: Vec<String> = serde_json::from_value(available.clone())
            .map_err(|_| "Surge 可达节点列表无法解析".to_string())?;
        return Ok(names
            .into_iter()
            .map(|name| {
                (
                    name,
                    NodeProbe {
                        reachable: true,
                        delay_ms: None,
                    },
                )
            })
            .collect());
    }
    let mut probes = HashMap::new();
    if let Some(results) = value.get("results").and_then(Value::as_array) {
        // Older documented group-test response.
        for result in results {
            let data = result
                .get("data")
                .and_then(Value::as_object)
                .ok_or("Surge 测速明细无法识别")?;
            for (name, value) in data {
                probes.insert(name.clone(), parse_probe(value)?);
            }
        }
    } else {
        // Captured Mac 6.10 /policies/test response: { memberName: metrics }.
        let data = value
            .as_object()
            .filter(|data| !data.is_empty())
            .ok_or("Surge 测速结果无法识别，未将节点标记为不可用")?;
        for (name, value) in data {
            probes.insert(name.clone(), parse_probe(value)?);
        }
    }
    Ok(probes)
}

fn parse_probe(value: &Value) -> Result<NodeProbe, String> {
    match value.get("available") {
        Some(Value::Bool(reachable)) => Ok(NodeProbe {
            reachable: *reachable,
            delay_ms: None,
        }),
        Some(Value::Number(duration)) => match duration.as_f64().filter(|n| n.is_finite()) {
            Some(ms) if ms > 0.0 && ms <= u32::MAX as f64 => Ok(NodeProbe {
                reachable: true,
                delay_ms: Some(ms.ceil() as u32),
            }),
            Some(ms) if ms <= 0.0 => Ok(NodeProbe::unreachable()),
            _ => Err("Surge 测速延迟无效".into()),
        },
        _ if value
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| !error.is_empty()) =>
        {
            Ok(NodeProbe::unreachable())
        }
        _ => Err("Surge 测速结果无法识别，未提供明确的节点连通性结果".into()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::Mutex,
    };

    #[derive(Debug)]
    pub struct FakeSurge {
        pub selected: String,
        pub mode: String,
        pub dead: Vec<String>,
        pub delays: HashMap<String, u32>,
        pub external: Vec<String>,
        pub bad_probe: bool,
        pub calls: Vec<(String, String, Value)>,
    }

    // Fake server for control-flow tests; captured wire shapes are tested below.
    pub async fn fake_surge(
        nodes: &[&str],
        current: &str,
    ) -> (SurgeSettings, Arc<Mutex<FakeSurge>>) {
        let nodes: Vec<String> = nodes.iter().map(|s| s.to_string()).collect();
        let state = Arc::new(Mutex::new(FakeSurge {
            selected: current.into(),
            mode: "rule".into(),
            dead: vec![],
            delays: HashMap::new(),
            external: vec![],
            bad_probe: false,
            calls: vec![],
        }));
        let shared = state.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut raw = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buffer[..n]);
                    let text = String::from_utf8_lossy(&raw);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|s| s.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if raw.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let raw = String::from_utf8_lossy(&raw);
                let mut first = raw.lines().next().unwrap_or_default().split_whitespace();
                let method = first.next().unwrap_or_default();
                let path = first.next().unwrap_or_default();
                let url = reqwest::Url::parse(&format!("http://localhost{path}")).unwrap();
                let body: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap_or(""))
                    .unwrap_or(Value::Null);
                let mut state = shared.lock().await;
                state.calls.push((method.into(), path.into(), body.clone()));
                let authenticated = raw
                    .lines()
                    .any(|line| line.eq_ignore_ascii_case("x-key: test-key"));
                let (status, response) = if !authenticated {
                    (401, json!({"error": "unauthorized"}))
                } else {
                    match (method, url.path()) {
                        ("GET", "/v1/outbound") => (200, json!({"mode": state.mode})),
                        ("GET", "/v1/policies") => (
                            200,
                            json!({"proxies": nodes.iter().filter(|node| !state.external.contains(node)).collect::<Vec<_>>(), "policy-groups": ["果到雷达"]}),
                        ),
                        ("GET", "/v1/policy_groups") => (
                            200,
                            json!({"果到雷达": nodes.iter().map(|node| {
                            if state.external.contains(node) { json!({"name": node, "isGroup": false, "enabled": true, "typeDescription": "VMess", "lineHash": format!("POLICY::fixture-{node}")}) }
                            else { json!(node) }
                        }).collect::<Vec<_>>()}),
                        ),
                        ("GET", "/v1/policy_groups/select")
                            if url
                                .query_pairs()
                                .any(|(k, v)| k == "group_name" && v == "果到雷达") =>
                        {
                            (200, json!({"policy": state.selected}))
                        }
                        ("POST", "/v1/policy_groups/select")
                            if body["group_name"] == "果到雷达"
                                && nodes.iter().any(|node| body["policy"] == *node) =>
                        {
                            state.selected = body["policy"].as_str().unwrap().into();
                            (200, json!({}))
                        }
                        ("POST", "/v1/policies/test" | "/v1/policy_groups/test")
                            if state.bad_probe =>
                        {
                            (200, json!({"unexpected": true}))
                        }
                        ("POST", "/v1/policies/test") => {
                            let names = body["policy_names"].as_array().unwrap();
                            if !state.external.is_empty() || !state.delays.is_empty() {
                                let data: serde_json::Map<String, Value> = nodes.iter().filter(|node| names.iter().any(|token| {
                                    if state.external.contains(*node) { *token == format!("POLICY::fixture-{node}") } else { *token == **node }
                                })).map(|node| (node.clone(), if state.dead.contains(node) { json!({"available": false}) } else { json!({"available": state.delays.get(node).copied().unwrap_or(125), "tcp": 120, "receive": 130}) })).collect();
                                (200, Value::Object(data))
                            } else {
                                (
                                    200,
                                    json!({"available": names.iter().filter(|v| !state.dead.iter().any(|d| **v == *d)).collect::<Vec<_>>()}),
                                )
                            }
                        }
                        ("POST", "/v1/policy_groups/test") => (
                            200,
                            json!({"available": nodes.iter().filter(|node| !state.dead.contains(node)).collect::<Vec<_>>()}),
                        ),
                        _ => (404, json!({"error": "not found"})),
                    }
                };
                drop(state);
                let response = response.to_string();
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            }
        });
        (
            SurgeSettings {
                controller: format!("http://{address}"),
                secret: "test-key".into(),
                ..SurgeSettings::default()
            },
            state,
        )
    }

    #[tokio::test]
    async fn surge_api_auth_selection_and_probes() {
        let (settings, server) = fake_surge(&["DIRECT", "香港/01", "日本01"], "DIRECT").await;
        let controller = SurgeController::new(&settings).unwrap();
        assert_eq!(
            controller.version().await.unwrap(),
            "Surge HTTP API（已连接）"
        );
        let group = controller
            .group_nodes("果到雷达", "香港|日本")
            .await
            .unwrap();
        assert_eq!(group.nodes, vec!["香港/01", "日本01"]);
        assert_eq!(group.skipped, 1);
        assert_eq!(
            controller.node_probe("香港/01").await.unwrap(),
            NodeProbe {
                reachable: true,
                delay_ms: None
            }
        );
        server.lock().await.dead.push("日本01".into());
        assert!(!controller.node_probe("日本01").await.unwrap().reachable);
        assert!(
            !controller
                .group_probes("果到雷达", &group.nodes)
                .await
                .unwrap()["日本01"]
                .reachable
        );
        controller.select("果到雷达", "香港/01").await.unwrap();
        assert_eq!(server.lock().await.selected, "香港/01");
        assert!(
            controller
                .group_nodes("不存在", "")
                .await
                .unwrap_err()
                .contains("没有名为")
        );
        let calls = &server.lock().await.calls;
        assert!(
            calls
                .iter()
                .any(|(_, path, _)| path.contains("group_name=%E6"))
        );
        assert!(calls.iter().any(|(_, path, body)| path == "/v1/policies/test" && body["url"] == DELAY_TEST_URL));
        assert!(calls.iter().all(|(method, path, _)| method != "POST"
            || matches!(
                path.as_str(),
                "/v1/policy_groups/select" | "/v1/policies/test" | "/v1/policy_groups/test"
            )));
    }

    #[tokio::test]
    async fn authentication_mode_and_unknown_response_are_errors() {
        let (mut settings, server) = fake_surge(&["香港01"], "香港01").await;
        settings.secret = "wrong-key".into();
        assert!(
            SurgeController::new(&settings)
                .unwrap()
                .version()
                .await
                .unwrap_err()
                .contains("密钥")
        );
        settings.secret = "test-key".into();
        let controller = SurgeController::new(&settings).unwrap();
        server.lock().await.mode = "proxy".into();
        assert!(
            controller
                .select("果到雷达", "香港01")
                .await
                .unwrap_err()
                .contains("规则模式")
        );
        assert!(
            !server
                .lock()
                .await
                .calls
                .iter()
                .any(|(m, p, _)| m == "POST" && p == "/v1/policy_groups/select")
        );
        server.lock().await.bad_probe = true;
        assert!(
            controller
                .node_probe("香港01")
                .await
                .unwrap_err()
                .contains("无法识别")
        );
    }

    #[tokio::test]
    async fn external_members_use_identifiers_only_for_testing() {
        let (settings, server) = fake_surge(&["DIRECT", "外部/香港01"], "DIRECT").await;
        server.lock().await.external.push("外部/香港01".into());
        let controller = SurgeController::new(&settings).unwrap();
        assert_eq!(
            controller.node_probe("外部/香港01").await.unwrap().delay_ms,
            Some(125)
        );
        controller.select("果到雷达", "外部/香港01").await.unwrap();
        let state = server.lock().await;
        assert_eq!(state.selected, "外部/香港01");
        assert!(
            state
                .calls
                .iter()
                .any(|(_, path, body)| path == "/v1/policies/test"
                    && body["policy_names"] == json!(["POLICY::fixture-外部/香港01"]))
        );
        assert!(
            state
                .calls
                .iter()
                .any(|(_, path, body)| path == "/v1/policy_groups/select"
                    && body["policy"] == "外部/香港01")
        );
        assert!(
            !state
                .calls
                .iter()
                .any(|(_, path, _)| path == "/v1/policy_groups/test"
                    || path.contains("include_external"))
        );
    }

    #[test]
    fn mac_610_captured_members_and_probe_results() {
        // Sanitized Surge Mac 6.10 responses captured on 2026-10-17.
        let groups: Value =
            serde_json::from_str(include_str!("../tests/fixtures/surge_groups.json")).unwrap();
        let probes: Value =
            serde_json::from_str(include_str!("../tests/fixtures/surge_probes.json")).unwrap();
        let nodes = parse_group_nodes(&groups, "果到雷达", "").unwrap();
        assert_eq!(nodes.nodes, vec!["DIRECT", "香港01", "新加坡01"]);
        let members = group_members(&groups, "果到雷达").unwrap();
        assert_eq!(members[1].name(), "香港01");
        assert_eq!(members[1].probe_token(), "POLICY::fixture-hong-kong");
        let probes = parse_probes(&probes).unwrap();
        assert_eq!(probes["香港01"].delay_ms, Some(452));
        assert_eq!(probes["新加坡01"].delay_ms, Some(35));
        let excluded = json!({"果到雷达": [
            {"name":"停用", "enabled":false, "typeDescription":"VMess"},
            {"name":"嵌套", "isGroup":true},
            {"name":"拒绝", "typeDescription":"REJECT"}
        ]});
        assert!(
            parse_group_nodes(&excluded, "果到雷达", "")
                .unwrap()
                .nodes
                .is_empty()
        );
    }

    #[test]
    fn group_filters_keep_selection_tokens_and_exclude_groups() {
        let groups = json!({
            "果到雷达": [{"name":"DIRECT","type":"direct"}, {"name":"外部/香港","type":"ss"}, {"name":"自动选择","type":"url-test"}, {"name":"拒绝别名","type":"reject"}, {"name":"套餐到期","type":"ss"}],
            "自动选择": ["外部/香港"]
        });
        assert_eq!(
            parse_group_nodes(&groups, "果到雷达", "").unwrap().nodes,
            vec!["DIRECT", "外部/香港"]
        );
        assert!(
            parse_group_nodes(&json!({"果到雷达": {"unexpected": []}}), "果到雷达", "").is_err()
        );
    }

    #[test]
    fn probe_formats_do_not_infer_reachability_from_missing_latency() {
        let probes = parse_probes(&json!({"available": ["A"]})).unwrap();
        assert_eq!(
            probes["A"],
            NodeProbe {
                reachable: true,
                delay_ms: None
            }
        );
        let probes = parse_probes(&json!({"results":[{"data": {
            "A":{"available":125.4}, "B":{"available":false}, "C":{"error":"timeout"}
        }}]}))
        .unwrap();
        assert_eq!(probes["A"].delay_ms, Some(126));
        assert!(!probes["B"].reachable);
        assert!(!probes["C"].reachable);
        assert!(parse_probes(&json!({"status":"ok"})).is_err());
        assert!(parse_probes(&json!({"available":[{}]})).is_err());
        assert!(parse_probes(&json!({"results":[{"data":{"A":{"tcp":10}}}]})).is_err());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "需要 APW_SURGE_LIVE_CONFIG，实际对专用组候选节点测速"]
    async fn 真实surge读取并批量测速专用组() -> Result<(), String> {
        let path =
            std::env::var("APW_SURGE_LIVE_CONFIG").map_err(|_| "缺少 APW_SURGE_LIVE_CONFIG")?;
        let config: Value =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let settings = SurgeSettings {
            controller: config["base"].as_str().ok_or("缺少控制地址")?.into(),
            secret: config["secret"].as_str().ok_or("缺少密钥")?.into(),
            group: config["group"].as_str().ok_or("缺少策略组")?.into(),
            ..Default::default()
        };
        let controller = SurgeController::new(&settings)?;
        controller.version().await?;
        let group = controller.group_nodes(&settings.group, "").await?;
        let probes = controller
            .group_probes(&settings.group, &group.nodes)
            .await?;
        let available = probes.values().filter(|probe| probe.reachable).count();
        let missing = group
            .nodes
            .iter()
            .filter(|name| name.as_str() != "DIRECT" && !probes.contains_key(*name))
            .count();
        eprintln!(
            "Surge live batch: members={}, skipped={}, tested={}, reachable={}, unreachable={}, unknown={missing}",
            group.nodes.len(),
            group.skipped,
            probes.len(),
            available,
            probes.len() - available
        );
        if missing > 0 {
            return Err("部分候选节点未返回测试结果".into());
        }
        Ok(())
    }
}
