# Deploying Tharam

## Main server

`deploy.sh` sets up (or updates) the main server on Ubuntu: the web app, the database, the scheduler and, by default, the browser that runs checks.

```
curl -fsSL https://raw.githubusercontent.com/swattoolchain/smart/main/deploy/deploy.sh | sudo bash   # first time
sudo bash /opt/tharam/deploy/deploy.sh                                                                # updates
```

Settings live in `/opt/tharam/deploy/.env`. `RUN_CONCURRENCY` is how many checks the main server runs at once.

## Workers (more machines for checks)

Add a worker when the founder console's **Capacity** tab says "Time to add a worker", or before a big sale. A worker is a separate VM that runs checks for the main server: it asks the main server for work, runs the check in its own browser, and sends back the result and screenshots. It opens no ports and keeps no customer data, database or secrets. It gets only what each check needs, and its local copies are deleted after upload.

Workers currently take journey checks (the frequent ones). Full checks, publish checks and free checks stay on the main server.

### Add one

1. **Founder console → Runners → Add a worker.** Give it a name, a number of slots (checks at once; about 1 slot per 2 GB of memory and 1 CPU) and optional tags:
   - `sale`: preferred by stores in sale mode
   - a plan key such as `pro`: preferred by stores on that paid plan
   - a region such as `india`, `eu`, `us`, `uk`, `asia` or `au`: preferred by stores selling there

   If no runner with a store's preferred tag has room, any runner takes the check. You get a **join token**. It works once and expires after 24 hours.

2. **On a fresh Ubuntu VM** (2 GB+ memory), run:

   ```
   curl -fsSL https://raw.githubusercontent.com/swattoolchain/smart/main/deploy/worker.sh | sudo bash
   ```

   It installs Docker, downloads the code to `/opt/tharam-worker` and asks for:
   - the main server address (`https://tharam.store`; https only, because store passwords travel with each check)
   - the join token

   To skip the questions: `curl -fsSL …/worker.sh | sudo MAIN_URL=https://tharam.store JOIN_TOKEN=tjr_… bash`.

3. The script builds the worker, waits until it has joined, removes the used token from `worker.env`, and checks that the worker is talking to the main server. In **Runners** it shows as *Checking in*.

The worker's credentials (from the join) are kept in its Docker volume (`tharam-worker_worker-data`, file `runner.json`), so restarts and updates don't need a new token.

### Day to day

| What | How |
| --- | --- |
| Update the code | `sudo bash /opt/tharam-worker/deploy/worker.sh` (no questions) |
| Logs | `cd /opt/tharam-worker/deploy && docker compose -p tharam-worker -f docker-compose.worker.yml logs -f worker` |
| Take it out of service | **Drain** in Runners (it finishes its current checks, takes no new ones), then `docker compose -p tharam-worker -f docker-compose.worker.yml down` |
| Pause it for a while | **Pause** in Runners; **Activate** to bring it back |
| Health | Docker marks the container unhealthy when the main server hasn't answered for 60 seconds. The main server stops sending checks to a worker that hasn't checked in for 60 seconds, and retries its unfinished checks once on another machine. |

### If something goes wrong

- **"The worker could not join"**: the token was wrong, already used or older than 24 hours. Create a new one in Runners and run the script again.
- **"The main server no longer knows this runner"** in the logs: the runner was removed or its credentials are invalid. Remove the volume (`docker compose -p tharam-worker -f docker-compose.worker.yml down -v`), create a new token, and run the script again.
- **Shown as "Not responding" in Runners**: the VM is down or can't reach the main server. Its checks have already moved elsewhere; nothing is lost.
