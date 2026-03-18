import indexHtml from "./index.html";

const server = Bun.serve({
  routes: {
    "/": indexHtml,
  },
});

console.log(`Listening on http://localhost:${server.port}`);
