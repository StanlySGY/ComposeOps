# Security Policy

## Supported Versions

Security fixes target the latest stable release. Back up before upgrading older versions; automated upgrade coverage currently starts at 1.4.0.

| Version | Supported          |
| ------- | ------------------ |
| 1.5.x   | :white_check_mark: |
| < 1.5   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please use **GitHub's private vulnerability reporting**:

**https://github.com/StanlySGY/ComposeOps/security/advisories/new**

Private advisories keep the details confidential until a fix is released. You should receive an acknowledgement within 48 hours. If for some reason you do not, please follow up on an existing advisory or via a GitHub issue (without technical details) asking to check the advisories.

### What to Include

Please include as much of the following information as possible:

- Type of vulnerability (e.g., authentication bypass, SQL injection, privilege escalation)
- Affected version(s)
- Steps to reproduce (PoC if available)
- Potential impact
- Suggested fix (if you have one)

### Disclosure Policy

- We will confirm the receipt of your vulnerability report within 48 hours
- We will provide an initial assessment of the vulnerability within 5 business days
- We will work with you to understand the scope and impact
- We will keep you updated on our progress toward a fix
- Once a fix is ready, we will coordinate disclosure timing with you

### Security Fixes

- Critical vulnerabilities: Patched within 7 days
- High severity: Patched within 14 days
- Medium/Low severity: Patched in next regular release

## Known Security Considerations

### Docker Socket Access

⚠️ **ComposeOps requires access to the Docker socket (`/var/run/docker.sock`)**

This is equivalent to root access on the host system. Therefore:

- **Never expose ComposeOps directly to the public internet**
- **Use only on trusted networks** (localhost, VPN, or behind authenticated reverse proxy)
- **Single-user design**: Not suitable for multi-tenant deployments
- **Limit network exposure**: The shipped `docker-compose.yml` publishes `0.0.0.0:28765`
  (LAN-wide access with application authentication). For localhost-only access change the
  port mapping to `127.0.0.1:28765:3001`, and use Tailscale or a TLS reverse proxy for
  remote access — never publish the port to the public internet.

### Authentication

- **Strong passwords**: Minimum 10 characters enforced
- **Session security**: HttpOnly cookies with SameSite=Strict
- **No built-in 2FA**: Consider using a reverse proxy with OAuth2/OIDC
- **Password reset**: Currently requires database access (planned improvement)

### API Keys

- **Storage**: API keys (for AI integrations) are stored in SQLite database
- **Export protection**: Keys are NOT included in settings export
- **Transmission**: Use HTTPS for all remote access
- **Rotation**: Manually rotate keys regularly in Settings

### Project Management

- **Explicit approval**: Projects must be manually approved for operations
- **Directory validation**: Real path validation prevents path traversal
- **Command allowlist**: Only safe Docker Compose commands are exposed
- **Web shell restrictions**: Only accessible for managed containers

### Dependencies

We use automated dependency scanning:
- **Dependabot**: Enabled for npm packages
- **Regular updates**: Backend and frontend dependencies updated monthly
- **Vulnerability alerts**: GitHub Security Advisories monitored

## Security Best Practices for Deployment

### 1. Network Isolation

```yaml
# docker-compose.yml
ports:
  - "127.0.0.1:28765:3001"  # Only local access
```

Use Tailscale or reverse proxy for remote access:

```bash
# Tailscale (recommended)
tailscale serve --bg http://127.0.0.1:28765

# Or reverse proxy with HTTPS + auth
# Set TRUST_PROXY=1 in environment
```

### 2. HTTPS/TLS

When using a reverse proxy:

```nginx
# Nginx example
server {
    listen 443 ssl http2;
    server_name composeops.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://127.0.0.1:28765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. Container Security

```yaml
# docker-compose.yml security options
security_opt:
  - no-new-privileges:true
read_only: false  # Required for SQLite writes
cap_drop:
  - ALL
cap_add:
  - CHOWN
  - DAC_OVERRIDE
  - FOWNER
  - SETGID
  - SETUID
```

### 4. Environment Variables

```bash
# Never commit .env files
echo ".env" >> .gitignore

# Use secrets management for production
docker secret create admin_password password.txt
```

### 5. Regular Updates

```bash
# Update ComposeOps
cd /path/to/ComposeOps
git pull
docker compose build
docker compose up -d

# Update Docker itself
sudo apt update && sudo apt upgrade docker-ce
```

### 6. Audit Logging

- **Operations history**: All Compose operations are logged in SQLite
- **Export capability**: Settings can export audit trail
- **Review regularly**: Check for suspicious operations

### 7. Backup Security

Use the [online SQLite backup and offline restore guide](docs/public/BACKUP_RESTORE.md). Do not copy a live WAL-mode database file by itself: recent committed writes may exist only in its WAL. Full database backups contain credentials and sessions; keep them private and encrypt off-host copies. Settings JSON exports are not full backups.

## Security Checklist

Before deploying to production:

- [ ] Changed default admin password (if auto-setup was used)
- [ ] Bound to `127.0.0.1` or using VPN/reverse proxy
- [ ] HTTPS enabled for remote access
- [ ] `TRUST_PROXY=1` set if behind reverse proxy
- [ ] Docker and dependencies up to date
- [ ] Reviewed and approved all managed projects
- [ ] API keys rotated from defaults
- [ ] Database backups configured and encrypted
- [ ] Security headers configured in reverse proxy
- [ ] Rate limiting enabled (if using reverse proxy)

## Known Limitations

### Current Limitations

1. **Single-user only**: No multi-tenant isolation
2. **No 2FA**: Consider proxy-level authentication
3. **No audit export to SIEM**: Planned for a future release
4. **No IP allowlist**: Use firewall or reverse proxy

### Mitigation Strategies

- **Multi-user needs**: Use separate instances per user
- **Enhanced auth**: Implement OAuth2 at reverse proxy level (Authelia, Keycloak)
- **Audit requirements**: Export SQLite to external system regularly
- **IP restrictions**: Configure firewall rules or Cloudflare Access

## Security Updates

Security patches are announced via:

- GitHub Security Advisories
- Release notes (tagged with `[SECURITY]`)
- Email to security mailing list (planned)

Subscribe to GitHub releases to receive notifications.

## Acknowledgments

We thank the security researchers who have responsibly disclosed vulnerabilities:

- *No disclosures yet*

## Contact

For security concerns:
- **Private security advisory**: https://github.com/StanlySGY/ComposeOps/security/advisories/new

For general questions:
- **GitHub Issues**: https://github.com/StanlySGY/ComposeOps/issues
- **Discussions**: https://github.com/StanlySGY/ComposeOps/discussions
