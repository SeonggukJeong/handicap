# Slice 3 — UI manual smoke checklist

Run this before merging Slice 3. The dev loop is:

```bash
# T0
cargo run -p handicap-controller -- --rest-addr 127.0.0.1:8080 --ui-dir ui/dist

# T1
cd ui && pnpm dev
```

Open http://localhost:5173 (the Vite dev server proxies `/api` → the controller).

## 1. New scenario flow

- [ ] `/scenarios/new` shows three panes: Variables panel on the left, Canvas tab on the middle, empty inspector on the right.
- [ ] Canvas is empty with the prompt "Canvas is empty. Click 'Add step' to begin."
- [ ] Click **+ Add step** twice → two boxes appear in a horizontal chain with an arrow between them.
- [ ] Click the first box → Inspector populates (name, method, URL fields).
- [ ] Change method to POST, URL to `{{base_url}}/login`, name to `login`. The canvas box updates live.
- [ ] Add a header `Content-Type: application/json`. Switch body kind to `json`, paste `{"u":"a"}`, blur the textarea.
- [ ] Add an assertion `200`.
- [ ] Click the second box → repeat with GET `{{base_url}}/me`, assertion 200.
- [ ] Switch to **YAML** tab. Confirm:
  - `steps` has two entries with the IDs you just added
  - `request.headers.Content-Type` is present on step 1
  - `body.json.u: a` is present on step 1
- [ ] Edit the YAML directly: change `{{base_url}}` to `{{base_url}}/v1`. Within ~300 ms the model accepts the edit (no error appears below the editor).
- [ ] Switch back to **Canvas**. Click step 1 → URL field reflects `{{base_url}}/v1/login`.
- [ ] Click **Create**. Browser navigates to `/scenarios/<id>`.

## 2. Round-trip (comment preservation)

- [ ] In the editor, switch to **YAML** tab. Add a comment line above the first step:

  ```yaml
  # production login flow
    - id: "..."
  ```

- [ ] Wait 300 ms (YAML pane shows no error).
- [ ] Switch to **Canvas** tab, click step 1, change its **name** to `prod-login`.
- [ ] Switch back to **YAML** tab. The `# production login flow` comment is still present.
- [ ] Click **Save**. Banner shows "Saving…" then disappears.
- [ ] Hard-refresh the page. The comment is still there after the round-trip through the backend.

## 3. Invalid YAML never poisons the model

- [ ] In **YAML** tab, replace `version: 1` with `version: not a number`. Below the editor an error like `YAML invalid: version: Expected literal value 1, received string` appears within ~300 ms.
- [ ] Switch to **Canvas** tab. Canvas still shows the *last valid* state (with two steps).
- [ ] Click **Save**. The button is enabled (because `yamlText` is the last valid value); the request succeeds.
- [ ] Switch back to **YAML** — the invalid text is preserved in the pending buffer (no auto-discard).

## 4. Delete and reorder

- [ ] Click step 2 → Inspector → click `↑` button → step 2 swaps with step 1 in the canvas chain.
- [ ] Click step 2 (now leftmost) → click **Delete**. Canvas now shows a single step.

## 5. Run flow regression

- [ ] Click **Runs** in the header → **New run** → run with VUs 10 / duration 5 s / env `BASE_URL=http://127.0.0.1:9090`.
- [ ] Boot a wiremock or any local HTTP responder on 9090 (see Slice 1 runbook). Confirm the run reaches `completed` and metrics appear (regression check — Slice 2 functionality still works).

## 6. Offline runtime check (CSP)

- [ ] In Chrome DevTools → Network → Throttling → **Offline (allow `/api`)** ... easiest: stop the dev server, run `pnpm build` then `pnpm preview` (port 4173) with the controller serving `--ui-dir ui/dist`.
- [ ] Open the page on `http://127.0.0.1:8080`. Confirm:
  - Canvas + Monaco both render
  - No DevTools console errors mentioning CSP, blocked workers, or missing fonts
  - Open DevTools → Application → Service Workers / Storage — there should be **no** outbound network requests to jsdelivr.net, fonts.googleapis.com, or any CDN

## 7. Lint / test / build green

```bash
cd ui && pnpm lint && pnpm test --run && pnpm build
cargo fmt --check && cargo build --workspace && cargo test --workspace
```

All green.
