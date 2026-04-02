# Running NanoClaw on a Google Cloud VM

This setup targets a Linux VM, typically Ubuntu 22.04 or 24.04 on Google Compute Engine, using Docker Compose for the main NanoClaw process and Docker on the host for agent containers.

## Architecture

- The main `nanoclaw` process runs in one long-lived Docker Compose service
- That service mounts the Docker socket from the VM host
- When NanoClaw wakes an agent, it still launches a normal `nanoclaw-agent:latest` container on the VM host

This means you do **not** need to expose a NanoClaw HTTP port to the internet. In the common WhatsApp/self-chat setup, inbound traffic comes from the messaging channel, not from public HTTP requests.

## 1. Create the VM

Recommended baseline:

- Ubuntu 22.04 LTS or 24.04 LTS
- e2-standard-4 or larger if you expect multiple concurrent agents
- 40 GB+ disk if you expect browser usage, logs, and container image churn

Firewall:

- Allow SSH on port 22
- Do not open extra inbound ports unless you later add a channel or feature that explicitly needs one

## 2. Attach a persistent disk path

If you want clean separation from the boot disk, mount a persistent disk at `/mnt/disks/nanoclaw` and clone the repo there.

If you prefer to keep things simple, use `/opt/nanoclaw` on the VM boot disk.

The path matters because NanoClaw passes host paths into `docker run`. The containerized main process must see the repo at the same absolute path as the Docker host.

## 3. Install Docker and Compose

On the VM:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"
newgrp docker
docker info
docker compose version
```

## 4. Clone NanoClaw into a fixed path

Example using `/opt/nanoclaw`:

```bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
git clone https://github.com/thiagocsousa/nanoclaw.git /opt/nanoclaw
cd /opt/nanoclaw
```

## 5. Prepare `.env`

Start from the example:

```bash
cp .env.gcp.example .env
```

Required value:

```bash
NANOCLAW_ROOT=/opt/nanoclaw
```

Use the exact absolute path where the repo exists on the VM host.

Then add your normal NanoClaw environment variables as needed for your setup.

## 6. Build and start

```bash
docker compose build
docker compose up -d
docker compose logs -f nanoclaw
```

The entrypoint does the following automatically:

- validates `NANOCLAW_ROOT`
- ensures `node_modules` exists
- builds `dist/` when needed
- builds `nanoclaw-agent:latest` when the container image inputs change
- starts `npm start`

## 7. Persistence

Persistence comes from the bind-mounted repository itself. These paths remain on the VM host:

- `groups/`
- `store/`
- `data/`
- `logs/`
- `.env`

`node_modules/` is stored in a Docker volume to avoid host pollution and repeated reinstalls.

## 8. Updating

```bash
cd /opt/nanoclaw
git pull
docker compose up -d --build
docker compose logs -f nanoclaw
```

## 9. Useful commands

```bash
docker compose ps
docker compose logs -f nanoclaw
docker compose restart nanoclaw
docker images | grep nanoclaw-agent
docker ps --format '{{.Names}} {{.Status}}'
```

## 10. Remote access notes

If you use NanoClaw's Remote Control feature, prefer access through:

- SSH to the VM
- or an SSH tunnel / IAP tunnel

Do not open broad public firewall rules unless you have a concrete reason.

## 11. Common failure modes

### Docker socket not mounted

Symptom:

- NanoClaw starts but agent execution fails immediately

Check:

```bash
docker compose exec nanoclaw docker info
```

### Wrong `NANOCLAW_ROOT`

Symptom:

- agent containers fail on bind mounts
- group directories appear missing inside agent runs

Fix:

- ensure the repo exists on the VM host exactly at `NANOCLAW_ROOT`
- ensure the Compose service mounts that same host path to the same container path

### `nanoclaw-agent:latest` missing

Symptom:

- the main service runs but agent launches fail

Fix:

```bash
cd /opt/nanoclaw
bash container/build.sh
docker compose restart nanoclaw
```
