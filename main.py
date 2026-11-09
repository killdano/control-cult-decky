# Control Cult's Decky panel, backend side: the status Control Cult writes, a phone pairing code, the current layout's
# picture, and Control Cult's settings and always-on widgets through the small server the Control Cult app runs on this Deck
# only (local.json: port and token). Control Cult itself runs as its own service; this plugin is a window onto it.
import json
import os
import shutil
import time
import asyncio
import urllib.request
import urllib.error
import urllib.parse
import decky

DATA = os.path.join(decky.DECKY_USER_HOME, ".local", "share", "steam-input-assistant")

# The watchdog: restarts the app's service when it stops answering here. Every assistant tool runs through the
# app, so nothing can reach this Deck while it hangs; systemd only steps in after a crash, not a hang.
SERVICE = "noobdeity.service"  # installer/deck/setup.sh
SYSTEMCTL = "systemctl"
WATCH_TICK = 15  # seconds between looks
WATCH_PROBE = 5  # how long one look waits for an answer
WATCH_SILENCE = 90  # silence that counts as stuck
WATCH_GAP = 45  # longer than this between two looks: the Deck slept (or this process stalled), so the silence starts over
WATCH_MAX_RESTARTS = 3  # at most this many restarts...
WATCH_WINDOW = 3600  # ...in this many seconds, so a broken install isn't restarted every 90 s forever
UPDATE_MAX_AGE = 600  # an update marker older than this was left by an update that died


def _app():
    node = os.path.join(DATA, "node", "bin", "node")
    try:
        with open(os.path.join(DATA, "app", "current")) as f:
            cur = f.read().strip()
    except OSError:
        return None
    cli = os.path.join(DATA, "app", "releases", cur, "src", "cli.mjs")
    return (node, cli) if os.path.exists(node) and os.path.exists(cli) else None


async def _run(*args, timeout=30):
    app = _app()
    if not app:
        return None, "Control Cult isn't installed on this Deck."
    env = dict(os.environ, HOME=decky.DECKY_USER_HOME, SIA_APP_DIR=os.path.join(DATA, "app"), SIA_DATA=DATA)
    proc = await asyncio.create_subprocess_exec(app[0], app[1], *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return None, "Control Cult took too long to answer."
    if proc.returncode != 0:
        if out.decode(errors="replace").startswith("Usage: sia"):
            # The installed app is older than this panel (it updates itself every 30 minutes).
            return None, "Control Cult is updating to the version this panel needs. Try again in a few minutes, or restart the Deck."
        return None, (err.decode(errors="replace").strip().splitlines() or ["Something went wrong."])[-1][:300]
    return out.decode(errors="replace"), None


def _local_info():
    try:
        with open(os.path.join(DATA, "local.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _local_call(method, path, body=None, timeout=15):
    info = _local_info()
    if not info:
        return {"error": "Control Cult's settings aren't reachable yet: it may be updating. Try again in a minute, or restart the Deck.", "down": True}
    url = "http://127.0.0.1:%d%s%st=%s" % (info["port"], path, "&" if "?" in path else "?", info["token"])
    data = json.dumps(body or {}).encode() if method == "POST" else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return {"error": json.loads(e.read().decode()).get("error") or str(e)}
        except ValueError:
            return {"error": str(e)}
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"error": "Control Cult isn't answering (%s). It may be restarting." % getattr(e, "reason", e), "down": True}


def _answering():
    return not _local_call("GET", "/alive", None, WATCH_PROBE).get("down")


# The app's marker while it downloads and installs a new release (backend.mjs updateIfNeeded): no server runs then.
def _updating():
    try:
        return time.time() - os.path.getmtime(os.path.join(DATA, "app", "updating")) < UPDATE_MAX_AGE
    except OSError:
        return False


def watchdog_state():
    return {"quiet_since": None, "last_look": None, "restarts": [], "gave_up": False}


# One look, with no side effects: returns the new state and None, "restart" or "give_up" (said once per stretch).
# now: seconds on a clock that keeps counting through sleep. The silence starts when the watchdog does, which is after
# boot, so the first 90 s after boot never count. hold: a reason to stay out of it; the silence starts over after one.
def watchdog_step(st, now, answering, hold=None):
    last = st["last_look"]
    st = {**st, "last_look": now, "restarts": [t for t in st["restarts"] if now - t < WATCH_WINDOW]}
    slept = last is not None and now - last > WATCH_GAP
    if answering or hold or slept or st["quiet_since"] is None:
        return {**st, "quiet_since": now}, None
    if now - st["quiet_since"] < WATCH_SILENCE:
        return st, None
    if len(st["restarts"]) >= WATCH_MAX_RESTARTS:
        return {**st, "gave_up": True}, None if st["gave_up"] else "give_up"
    return {**st, "quiet_since": now, "gave_up": False, "restarts": st["restarts"] + [now]}, "restart"


# Whether systemd says to stay out of it. "inactive" is a stop someone asked for (the installer, uninstalling, a
# systemctl stop); exits 2 and 3 are the app stopping itself (not joined, removed from the account: the unit's
# RestartPreventExitStatus).
def service_hold(props):
    if props.get("LoadState") != "loaded":
        return "the service isn't installed"
    state = props.get("ActiveState")
    if state in ("inactive", "deactivating"):
        return "the service was stopped"
    if state == "failed" and props.get("ExecMainStatus") in ("2", "3"):
        return "the app stopped itself (exit %s)" % props["ExecMainStatus"]
    return None


# This process is the Deck's user (plugin.json asks for no root), but under Decky's system service: nothing in its
# environment leads to the user's systemd, and Decky's own library path must not reach system programs.
def _service_env():
    run = "/run/user/%d" % os.stat(decky.DECKY_USER_HOME).st_uid
    return {"PATH": "/usr/bin:/bin", "HOME": decky.DECKY_USER_HOME, "XDG_RUNTIME_DIR": run, "DBUS_SESSION_BUS_ADDRESS": "unix:path=%s/bus" % run}


async def _systemctl(*args, timeout=15):
    proc = await asyncio.create_subprocess_exec(SYSTEMCTL, "--user", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=_service_env())
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return None, "systemctl took too long"
    return (out.decode(errors="replace"), None) if proc.returncode == 0 else (None, err.decode(errors="replace").strip()[:300] or "exit %d" % proc.returncode)


async def _hold_reason():
    if not _app():
        return "Control Cult isn't installed"
    if _updating():
        return "an update is installing"
    try:
        out, err = await _systemctl("show", SERVICE, "--property=LoadState,ActiveState,ExecMainStatus")
    except OSError as e:
        out, err = None, str(e)
    if err:
        return "the service can't be read: %s" % err
    return service_hold(dict(l.split("=", 1) for l in out.splitlines() if "=" in l))


# One look and what follows from it. The technical log picks out every line with "watchdog:" (techlog.mjs).
async def _watch_look(st, now=None):
    now = time.clock_gettime(time.CLOCK_BOOTTIME) if now is None else now
    answering = await asyncio.to_thread(_answering)
    hold = None if answering else await _hold_reason()
    if hold and hold != st.get("held"):
        decky.logger.info("watchdog: Control Cult isn't answering; leaving it alone: %s", hold)
    if answering and st.get("restarted_at") is not None:
        decky.logger.info("watchdog: Control Cult answers again, %d s after the restart", now - st["restarted_at"])
        st = {**st, "restarted_at": None}
    st, action = watchdog_step({**st, "held": hold}, now, answering, hold)
    if action == "give_up":
        decky.logger.error("watchdog: %d restarts in an hour didn't bring Control Cult back; not trying again for now", WATCH_MAX_RESTARTS)
    elif action == "restart":
        decky.logger.warning("watchdog: Control Cult hasn't answered for %d s; restarting %s (%d of %d this hour)", WATCH_SILENCE, SERVICE, len(st["restarts"]), WATCH_MAX_RESTARTS)
        try:
            _, err = await _systemctl("restart", "--no-block", SERVICE)
        except OSError as e:
            err = str(e)
        if err:
            decky.logger.error("watchdog: the restart failed: %s", err)
        else:
            st = {**st, "restarted_at": now}
    return st


async def _watchdog():
    st = watchdog_state()
    while True:
        try:
            st = await _watch_look(st)
        except Exception as e:  # one bad look must not end the watchdog
            decky.logger.error("watchdog: %s", e)
        await asyncio.sleep(WATCH_TICK)


# Installing Control Cult from Game Mode: a player who found this panel in a Decky store installs
# the app from here, with no Desktop Mode. The same setup the Desktop Mode launcher runs (installer/deck/setup.sh, served
# by the backend with its address filled in), without dialogs and without the Decky steps: Decky and this panel are
# already here. A code typed here is the invite or license code setup asks for; with none, the Deck joins as a new
# account that stays locked until a license is entered in the panel.
BACKEND = os.environ.get("ND_BACKEND", "https://noobdeity.kill-dano.workers.dev")
INSTALL_TIMEOUT = 900
STEPS = (("Downloading", "Downloading Control Cult (about 90 MB)…"), ("Getting the Control Cult window", "Getting the window ready…"))


def _fetch(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


class _Install:
    def __init__(self):
        self.state, self.step, self.error, self.task = "idle", "", "", None

    def view(self):
        return {"state": self.state, "step": self.step, "error": self.error}

    async def run(self, code, uninstall=False):
        self.state, self.error = "running", ""
        self.step = "Removing Control Cult…" if uninstall else "Getting the installer…"
        tmp = None
        try:
            env = dict(_service_env(), ND_UI="none", SIA_DATA=DATA)
            if uninstall:
                script = os.path.join(DATA, "uninstall.sh")
                if not os.path.exists(script):
                    script = os.path.join(tempfile_dir(), "uninstall.sh")
                    with open(script, "wb") as f:
                        f.write(await asyncio.to_thread(_fetch, BACKEND + "/deck/uninstall.sh"))
                env["ND_CONFIRMED"] = "1"
            else:
                tmp = tempfile_dir()
                script = os.path.join(tmp, "setup.sh")
                with open(script, "wb") as f:
                    f.write(await asyncio.to_thread(_fetch, BACKEND + "/deck/setup.sh"))
                os.makedirs(DATA, exist_ok=True)
                open(os.path.join(DATA, "decky-offered"), "a").close()  # the Decky steps: already here
                env["ND_INVITE"] = code
                if not code:
                    env["ND_OPEN_JOIN"] = "1"  # no code yet: installed now, the license is entered in the panel after
            proc = await asyncio.create_subprocess_exec("bash", script, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env, cwd=decky.DECKY_USER_HOME)
            last = []

            async def read():
                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        return
                    text = line.decode(errors="replace").strip()
                    if not text:
                        continue
                    last.append(text)
                    del last[:-20]
                    for key, words in STEPS:
                        if text.startswith(key):
                            self.step = words
            try:
                await asyncio.wait_for(asyncio.gather(read(), proc.wait()), INSTALL_TIMEOUT)
            except asyncio.TimeoutError:
                proc.kill()
                raise RuntimeError("The install took too long. Check that the Deck is online and try again.")
            if proc.returncode != 0:
                msg = next((l[len("WARNING: "):] for l in reversed(last) if l.startswith("WARNING: ")), last[-1] if last else "exit %d" % proc.returncode)
                raise RuntimeError(msg[:400])
            self.state, self.step = "done", ("Control Cult was removed." if uninstall else "Control Cult is installed and starts with your Steam Deck.")
        except Exception as e:  # noqa: BLE001 - shown to the player as it is, then Try again
            decky.logger.warning("install: %s", e)
            self.state, self.error = "failed", (str(e) or "Something went wrong.")
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)


def tempfile_dir():
    import tempfile
    return tempfile.mkdtemp(prefix="controlcult-")


INSTALL = _Install()


class Plugin:
    async def status(self):
        if not _app():
            return {"installed": False}
        try:
            with open(os.path.join(DATA, "status.json")) as f:
                s = json.load(f)
        except (OSError, ValueError):
            # Older Control Cult releases don't write it; the app updates itself within 30 minutes.
            return {"installed": True, "noStatus": True}
        return {"installed": True, **s}

    # Install from the panel: starts it and returns at once; the panel asks install_state every second.
    async def install(self, code=""):
        code = "".join(str(code or "").split())
        if INSTALL.state == "running":
            return INSTALL.view()
        INSTALL.task = asyncio.create_task(INSTALL.run(code))
        await asyncio.sleep(0)
        return INSTALL.view()

    async def install_state(self):
        return INSTALL.view()

    async def uninstall(self):
        if INSTALL.state == "running":
            return INSTALL.view()
        INSTALL.task = asyncio.create_task(INSTALL.run("", uninstall=True))
        await asyncio.sleep(0)
        return INSTALL.view()

    async def pairing(self):
        out, err = await _run("pair", "--json")
        if err:
            return {"error": err}
        try:
            return json.loads(out.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return {"error": "No pairing code came back."}

    # Settings page and widgets: one passthrough to Control Cult's local server, limited to its known paths.
    async def local(self, method, path, body=None):
        allowed = ("/settings", "/usage", "/testers", "/invite", "/pair", "/overlay", "/pip", "/client", "/license", "/free")
        if method not in ("GET", "POST") or path not in allowed:
            return {"error": "not allowed"}
        return await asyncio.to_thread(_local_call, method, path, body)

    # Where the always-on widget pages are, for the browser views drawn over the game.
    async def pip(self, menu=None, drawn=None):
        info = _local_info()
        if not info:
            return {"widgets": [], "enabled": False}
        # menu: which of Steam's side menus is open (0 none, 1 the Steam menu, 2 Quick Access), so Control Cult can close
        # the drawer when the player goes into Steam's own screens.
        extra = "&menu=%d" % int(menu) if isinstance(menu, (int, float)) else ""
        # drawn: what the widget layer drew last (1.2.9+), for Control Cult's touch gate.
        if isinstance(drawn, str) and len(drawn) < 400:
            extra += "&drawn=" + urllib.parse.quote(drawn, safe=":,;.")
        r = await asyncio.to_thread(_local_call, "GET", "/pip?v=%s%s" % (getattr(decky, "DECKY_PLUGIN_VERSION", "?"), extra), None, 5)
        if "error" in r:
            decky.logger.warning("pip: %s", r["error"])
            return {"widgets": [], "enabled": False, "error": r["error"]}
        return {**r, "base": "http://127.0.0.1:%d" % info["port"], "token": info["token"]}

    async def _main(self):
        decky.logger.info("NoobDeity panel loaded")
        self._watch = asyncio.create_task(_watchdog())

    async def _unload(self):
        watch = getattr(self, "_watch", None)
        if watch:
            watch.cancel()
