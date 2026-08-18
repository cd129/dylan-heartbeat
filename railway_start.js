const { spawn } = require("child_process");
const path = require("path");
const { prepareRailwayPersistence } = require("./railway_persistence_guard");

// Railway 默认只执行一个 start command；公开版必须在同一容器同时托管
// Gateway 与 wake-up，才能共享本地/Volume 时间线。这里统一转发退出信号，避免后台子进程悄悄死掉。
// Gateway 使用 server_patched.js：
// - 普通 Kelivo 对话会知道 Bark 的真实能力边界，不再索要 Device Key；
// - /admin/test-bark 会真正发 Bark 推送，而不是只写时间线假事件。
let persistence;
try {
  persistence = prepareRailwayPersistence();
  if (persistence.checked) {
    console.log(JSON.stringify({
      event: "railway_persistence_guard",
      data_dir: persistence.dataDir,
      volume_mount_path: persistence.mountPath,
      probe_existing: persistence.probeExisting,
      probe_boots: persistence.probeBoots,
      distinct_device_from_app: persistence.distinctDeviceFromApp
    }));
  }
} catch (error) {
  console.error("Railway persistence guard failed", {
    name: error?.name || "Error",
    message: error?.message || String(error)
  });
  process.exit(1);
}

const processes = [
  ["gateway", "server_patched.js"],
  ["wake-up", "wake_up.js"]
].map(([name, file]) => ({
  name,
  child: spawn(process.execPath, [path.join(__dirname, file)], {
    cwd: __dirname,
    env: process.env,
    stdio: "inherit"
  })
}));

let stopping = false;

function stopAll(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of processes) {
    if (!child.killed) child.kill(signal);
  }
  setTimeout(() => process.exit(exitCode), 800).unref();
}

for (const { name, child } of processes) {
  child.on("error", error => {
    console.error(`${name} 启动失败:`, error.message || error);
    stopAll("SIGTERM", 1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name} 意外退出: code=${code ?? ""} signal=${signal || ""}`);
    stopAll("SIGTERM", code && code > 0 ? code : 1);
  });
}

process.on("SIGTERM", () => stopAll("SIGTERM", 0));
process.on("SIGINT", () => stopAll("SIGINT", 0));
