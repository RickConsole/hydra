---
name: restart-nanoclaw
description: Build TypeScript and restart the nanoclaw systemd service. Use when you've made code changes and need to deploy them.
---

# Restart NanoClaw

Run the following steps in order:

1. Build the TypeScript project:
   ```
   npm run build
   ```
   If the build fails, show the errors and stop.

2. Restart the systemd service:
   ```
   systemctl --user restart nanoclaw
   ```

3. Verify it's running:
   ```
   systemctl --user status nanoclaw
   ```
   Confirm the service is active and show the status to the user.
