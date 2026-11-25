use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

pub fn random_hex(len: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).map_err(|e| format!("生成安全随机数失败: {}", e))?;
    Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

pub fn is_loopback_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

pub fn is_allowed_collector_origin(origin: &str) -> bool {
    for prefix in ["chrome-extension://", "extension://"] {
        if let Some(rest) = origin.strip_prefix(prefix) {
            let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
            return !host.is_empty()
                && path.is_empty()
                && !host.contains(['@', ':', '?', '#', '\\']);
        }
    }
    is_loopback_origin(origin)
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || is_link_local_v6(&ip)
                || is_documentation_v6(&ip)
                || ip.segments()[0] & 0xe000 != 0x2000)
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.octets()[0] == 0
        || ip.octets()[0] >= 224
        || is_documentation_v4(&ip))
}

fn is_documentation_v4(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || (o[0] == 100 && (64..=127).contains(&o[1]))
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)
        || (o[0] == 198 && (18..=19).contains(&o[1]))
}

fn is_link_local_v6(ip: &Ipv6Addr) -> bool {
    let segments = ip.segments();
    (segments[0] & 0xffc0) == 0xfe80
}

fn is_documentation_v6(ip: &Ipv6Addr) -> bool {
    let segments = ip.segments();
    (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
}

fn is_fake_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.octets()[0] == 198 && (18..=19).contains(&ip.octets()[1]),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .is_some_and(|v4| is_fake_ip(IpAddr::V4(v4))),
    }
}

fn is_direct_public_ip(ip: IpAddr) -> bool {
    is_public_ip(ip) || is_fake_ip(ip)
}

pub fn validate_download_url(
    raw: &str,
    allow_loopback_test: bool,
    proxy_enabled: bool,
) -> Result<url::Url, String> {
    let url = parse_public_http_url(raw)?;
    if !proxy_enabled {
        resolved_public_address(&url, allow_loopback_test)?;
    } else if !allow_loopback_test {
        let host = url
            .host_str()
            .ok_or_else(|| "下载链接缺少主机名".to_string())?;
        if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
            && !is_public_ip(ip)
        {
            return Err("禁止采集内网、回环或链路本地地址".to_string());
        }
    }
    Ok(url)
}

fn parse_public_http_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "非法下载链接".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持不含凭据的 http 或 https 链接".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "下载链接缺少主机名".to_string())?;
    if host.trim_matches(['[', ']']).parse::<IpAddr>().is_err() {
        let domain = host.trim_end_matches('.').to_ascii_lowercase();
        if domain == "localhost" || domain.ends_with(".local") || !domain.contains('.') {
            return Err("禁止采集本地或单标签主机名".to_string());
        }
    }
    Ok(url)
}

pub fn resolved_public_address(
    url: &url::Url,
    allow_loopback_test: bool,
) -> Result<IpAddr, String> {
    let checked = parse_public_http_url(url.as_str())?;
    let host = match checked.host() {
        Some(url::Host::Domain(domain)) => domain.to_string(),
        Some(url::Host::Ipv4(ip)) => ip.to_string(),
        Some(url::Host::Ipv6(ip)) => ip.to_string(),
        None => return Err("下载链接缺少主机名".to_string()),
    };
    let port = checked
        .port_or_known_default()
        .ok_or_else(|| "下载链接缺少端口".to_string())?;
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "无法解析下载链接主机".to_string())?
        .collect();
    if addrs.is_empty() {
        return Err("下载链接主机没有可用地址".to_string());
    }
    for addr in &addrs {
        if !is_direct_public_ip(addr.ip()) && !(allow_loopback_test && addr.ip().is_loopback()) {
            return Err("禁止采集内网、回环或链路本地地址".to_string());
        }
    }
    Ok(addrs[0].ip())
}

pub fn resolve_download_address(
    url: &url::Url,
    allow_loopback_test: bool,
    proxy_enabled: bool,
) -> Result<Option<IpAddr>, String> {
    if proxy_enabled {
        return Ok(None);
    }
    let addr = resolved_public_address(url, allow_loopback_test)?;
    Ok((!is_fake_ip(addr)).then_some(addr))
}

pub fn curl_args_for_url(url: &url::Url, addr: Option<IpAddr>) -> Result<Vec<String>, String> {
    let mut args = vec![
        "--proto".to_string(),
        "=http,https".to_string(),
        "--proto-redir".to_string(),
        "=http,https".to_string(),
    ];
    let Some(addr) = addr.filter(|ip| !is_fake_ip(*ip)) else {
        return Ok(args);
    };
    let host = url
        .host_str()
        .ok_or_else(|| "下载链接缺少主机名".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "下载链接缺少端口".to_string())?;
    let resolve_host = host.trim_matches(['[', ']']);
    args.push("--resolve".to_string());
    args.push(format!(
        "{}:{}:{}",
        if resolve_host.contains(':') {
            format!("[{}]", resolve_host)
        } else {
            resolve_host.to_string()
        },
        port,
        addr
    ));
    Ok(args)
}

fn normalize_proxy(raw: &str) -> Option<String> {
    let proxy = raw.trim();
    if proxy.is_empty() || proxy.chars().any(char::is_control) {
        return None;
    }
    Some(proxy.to_string())
}

fn registry_proxy(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.contains('=') && raw.split(';').any(|part| part.contains('=')) {
        for scheme in ["https", "http", "socks"] {
            for part in raw.split(';') {
                let Some((name, value)) = part.split_once('=') else {
                    continue;
                };
                if name.trim().eq_ignore_ascii_case(scheme) {
                    return normalize_proxy(value);
                }
            }
        }
        None
    } else {
        normalize_proxy(raw)
    }
}

#[cfg(windows)]
fn windows_system_proxy() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    if key.get_value::<u32, _>("ProxyEnable").ok()? != 1 {
        return None;
    }
    registry_proxy(&key.get_value::<String, _>("ProxyServer").ok()?)
}

pub fn detect_curl_proxy() -> Option<String> {
    for name in [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
    ] {
        if let Some(proxy) = std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .and_then(|value| value.into_string().ok())
            .and_then(|value| normalize_proxy(&value))
        {
            return Some(proxy);
        }
    }
    #[cfg(windows)]
    {
        windows_system_proxy()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

pub fn validate_download_host_header(host: &str, expected_port: u16) -> bool {
    let Some((name, port)) = host.rsplit_once(':') else {
        return false;
    };
    is_loopback_host(name) && port.parse::<u16>().ok() == Some(expected_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_hex_is_unique_and_hex() {
        let a = random_hex(16).unwrap();
        let b = random_hex(16).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn origins_require_exact_loopback_host() {
        assert!(is_loopback_origin("http://127.0.0.1:5173"));
        assert!(is_loopback_origin("http://localhost:41600"));
        assert!(!is_loopback_origin("http://localhost.evil.example:41600"));
        assert!(!is_loopback_origin("http://127.0.0.1.evil.example:41600"));
        assert!(is_allowed_collector_origin(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        ));
        assert!(!is_allowed_collector_origin(
            "chrome-extension://user@example.com/"
        ));
        assert!(!is_allowed_collector_origin("null"));
    }

    #[test]
    fn host_header_rejects_dns_rebinding_names() {
        assert!(validate_download_host_header("127.0.0.1:41600", 41600));
        assert!(validate_download_host_header("localhost:1234", 1234));
        assert!(!validate_download_host_header(
            "localhost.evil.example:41600",
            41600
        ));
        assert!(!validate_download_host_header("127.0.0.1:41601", 41600));
    }

    #[test]
    fn private_and_loopback_urls_are_blocked() {
        assert!(!is_public_ip("::127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("64:ff9b::a00:1".parse().unwrap()));
        assert!(!is_public_ip("2001:db8::1".parse().unwrap()));
        for raw in [
            "http://127.0.0.1/image.png",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.2/image.png",
            "http://[::1]/image.png",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(validate_download_url(raw, false, false).is_err(), "{raw}");
        }
        assert!(validate_download_url("http://127.0.0.1/image.png", true, false).is_ok());
    }

    #[test]
    fn proxy_mode_validates_literal_targets_without_dns() {
        for raw in [
            "http://example.com/image.png",
            "https://images.example.com./image.png",
        ] {
            assert!(validate_download_url(raw, false, true).is_ok(), "{raw}");
        }
        for raw in [
            "http://127.0.0.1/image.png",
            "http://127.1/image.png",
            "http://2130706433/image.png",
            "http://0x7f000001/image.png",
            "http://127.0.0.1./image.png",
            "http://[::ffff:127.0.0.1]/image.png",
            "http://10.0.0.1/image.png",
            "http://172.16.0.1/image.png",
            "http://192.168.1.1/image.png",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/image.png",
            "http://0.0.0.0/image.png",
            "http://198.18.0.1/image.png",
            "http://[::1]/image.png",
            "http://[fc00::1]/image.png",
            "http://[fe80::1]/image.png",
            "http://localhost/image.png",
            "http://printer.local/image.png",
            "http://intranet/image.png",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(validate_download_url(raw, false, true).is_err(), "{raw}");
        }
    }

    #[test]
    fn fake_ip_direct_downloads_are_allowed_without_resolve_pinning() {
        let raw = "http://198.18.0.1/image.png";
        let url = validate_download_url(raw, false, false).unwrap();
        assert_eq!(resolve_download_address(&url, false, false).unwrap(), None);
        assert!(
            !curl_args_for_url(&url, None)
                .unwrap()
                .iter()
                .any(|arg| arg == "--resolve")
        );
        assert!(
            !curl_args_for_url(&url, Some("198.18.0.1".parse().unwrap()))
                .unwrap()
                .iter()
                .any(|arg| arg == "--resolve")
        );
        assert!(
            curl_args_for_url(&url, Some("93.184.216.34".parse().unwrap()))
                .unwrap()
                .iter()
                .any(|arg| arg == "--resolve")
        );
    }

    #[test]
    fn registry_proxy_server_selects_a_curl_compatible_endpoint() {
        assert_eq!(
            registry_proxy("http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892"),
            Some("127.0.0.1:7891".to_string())
        );
        assert_eq!(
            registry_proxy("127.0.0.1:7890"),
            Some("127.0.0.1:7890".to_string())
        );
        assert_eq!(registry_proxy("  "), None);
    }

    #[test]
    fn configured_csp_covers_inline_startup_script_line_endings() {
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD;
        use sha2::{Digest, Sha256};

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let index_path = manifest.join("../../ui/index.html");
        let index = std::fs::read_to_string(&index_path).unwrap();
        let start = index.find("<script>").unwrap() + "<script>".len();
        let end = start + index[start..].find("</script>").unwrap();
        let script = &index[start..end];
        let lf = script.replace("\r\n", "\n").replace('\r', "\n");
        let crlf = lf.replace('\n', "\r\n");
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(manifest.join("tauri.conf.json")).unwrap(),
        )
        .unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        for bytes in [lf.as_bytes(), crlf.as_bytes()] {
            let token = format!("'sha256-{}'", STANDARD.encode(Sha256::digest(bytes)));
            assert!(csp.contains(&token), "CSP 缺少内联脚本哈希 {token}");
        }
    }

    #[test]
    fn constant_time_comparison_checks_length_and_content() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }
}
