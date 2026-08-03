require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const routes = require("./src/routes");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";

app.use(express.json({ limit: "6mb" })); // generous enough for a resized team logo
app.use(
  session({
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

app.listen(PORT, () => {
  console.log("Padel league app running on http://localhost:" + PORT);
});
