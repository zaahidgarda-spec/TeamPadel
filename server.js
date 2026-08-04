require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const routes = require("./src/routes");
const store = require("./src/store");
const { createSessionStore } = require("./src/sessionStore");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";

// GoDaddy (like most hosts) terminates HTTPS at a proxy in front of this
// app, so Express itself only ever sees plain HTTP. Without this, it thinks
// every request is insecure and silently refuses to set the session cookie
// (cookie.secure below is true in production), which breaks login entirely.
app.set("trust proxy", 1);

app.use(express.json({ limit: "6mb" })); // generous enough for a resized team logo
const sessionStore = createSessionStore();
if (!sessionStore) {
  console.log("UPSTASH_REDIS_REST_URL/TOKEN not set — sessions are in-memory (fine locally, not for production).");
}
app.use(
  session({
    store: sessionStore || undefined, // undefined lets express-session fall back to MemoryStore
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production", // requires HTTPS in production
      maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days
    },
  })
);

app.use("/api", routes);
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

store
  .init()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Padel league app running on http://localhost:" + PORT);
    });
  })
  .catch((e) => {
    console.error("Failed to initialize data store:", e.message);
    process.exit(1);
  });

async function shutdown() {
  await store.flush();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
