import React from "react";
import { render } from "ink";
import { App } from "./app.js";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
Usage: dashboard-tui [options]

Options:
  --url <base-url>   Dashboard base URL (default: http://localhost:3097)
  --help, -h         Show this help message and exit
`);
  process.exit(0);
}

const urlIndex = argv.indexOf("--url");
const url =
  urlIndex !== -1 && argv[urlIndex + 1]
    ? argv[urlIndex + 1]
    : "http://localhost:3097";

const { unmount } = render(<App baseUrl={url} />);

process.on("SIGINT", () => {
  unmount();
  process.exit(0);
});

process.on("SIGTERM", () => {
  unmount();
  process.exit(0);
});
