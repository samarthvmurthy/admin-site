# Jobs runner (career-ops on the Dell)

The admin site's **Jobs** page queues work; this runner, on the always-on Windows
Dell, picks it up every ~15 seconds, runs it against the local career-ops
folder, and syncs the results back. It only makes outbound HTTPS requests —
nothing on the Dell is exposed to the internet.

```
Jobs page ──POST /api/jobs/run──▶ Worker ──▶ D1 (queue + mirror) ◀──claim / progress / sync── runner (Dell) ──▶ career-ops
```

- `actions-spec.mjs`: the **only** things the site can ask for. It's shared with
  the worker, and both validate every parameter. There is no way to send a command.
- `runner.mjs`: the poll loop. `--sync` syncs once, and `--once` runs one job.
- `sync.mjs`: mirrors the tracker, inbox, reports, PDFs, stats and follow-ups.
  The Dell's files stay the source of truth.
- `install.ps1`: installs the runner on Windows as a scheduled task that starts at boot.
- `pack-user-data.mjs`: one-time zip of your career-ops data on the Mac.

## One-time setup

### 1. Cloudflare (on the Mac, in `worker/`)

```bash
npx wrangler d1 create admin-jobs              # paste the printed database_id into wrangler.toml
npx wrangler d1 migrations apply admin-jobs --remote
openssl rand -hex 32                           # copy this: it's the runner token
npx wrangler secret put RUNNER_TOKEN           # paste it
npx wrangler deploy
```

Then in the **Cloudflare dashboard → Zero Trust → Access**:

1. **Service credentials → Service Tokens → Create**. Name it `dell-runner` and
   copy the Client ID and Client Secret. The secret is shown only once.
2. **Applications → the admin site app → Policies → Add a policy**:
   - Action: **Service Auth**
   - Include: **Service Token** = `dell-runner`

### 2. Package your data (on the Mac)

```bash
node runner/pack-user-data.mjs        # reads ~/career-ops
```

This writes `career-ops-userdata-<date>.zip` and `admin-runner-<date>.zip` to
`~/Downloads`. Copy both to the Dell over your remote connection.

### 3. The Dell (PowerShell)

```powershell
git clone https://github.com/santifer/career-ops C:\career-ops
cd C:\career-ops
npm install
npx playwright install chromium
Expand-Archive $HOME\Downloads\career-ops-userdata-*.zip -DestinationPath C:\career-ops -Force

Expand-Archive $HOME\Downloads\admin-runner-*.zip -DestinationPath C:\admin-runner -Force
```

Then open **PowerShell as Administrator** and run:

```powershell
cd C:\admin-runner
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1 -CareerOpsRoot C:\career-ops
```

It asks for the runner token and the two Access values, runs a test sync, and
registers the **AdminSite Jobs Runner** task. Within a minute the Jobs page
should say **Dell online**.

From now on, use career-ops on the Dell only, through the site. The Mac copy is retired.

## Day to day

- Every button is on the Jobs page. Runs, with their full output, are under **Activity**.
- If the Dell is off or offline, jobs wait in the queue and run when it's back.
- The log is at `C:\admin-runner\runner.log`.
- To stop or remove the runner: `.\install.ps1 -Uninstall` (as Administrator).

## Tests

```bash
cd runner && npm test
```
