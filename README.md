# ⚡ Veloce: Advanced Multi-Threaded Download Manager

Veloce is a high-performance, segmented Internet Download Manager (IDM) designed to aggressively capture, segment, and assemble web resources. It bypasses browser restrictions by splitting operations into three distinct, decoupled layers.

## 🏗️ System Architecture

### 1. `extension/` (Browser Extension)
*   **Tech Stack:** Svelte, Manifest V3
*   **Role:** The frontend UI inside the browser. It intercepts network requests, parses the page for media (`<video>`, `<a>`), and injects a floating UI. 
*   **How it talks:** It connects to the `backend` via a local **WebSocket**.

### 2. `backend/` (Local Coordinator)
*   **Tech Stack:** SvelteKit (Node.js full-stack), Drizzle ORM, SQLite
*   **Role:** This is the native dashboard app that runs on your PC. It receives download payloads from the extension. It uses SQLite (via Drizzle ORM) to safely store your download queue and history. If your PC crashes, Drizzle remembers exactly where the download stopped.
*   **How it works:** It acts as the "Manager". When a download starts, it spawns the Rust Engine as a **Child Process**.

### 3. `core_engine/` (Rust Core)
*   **Tech Stack:** Rust, Tokio, Reqwest
*   **Role:** The heavy lifter. A standalone executable invoked by the Local Coordinator. It handles the raw network connections, multi-threaded byte-range fetching, and writes the file chunks directly to your disk at maximum speed.

## 📚 Learning Concepts Explained

### WebSockets vs Native Messaging
To let the browser extension talk to your computer's native file system, we use **WebSockets**. The Local Coordinator runs a tiny server on your PC at `ws://localhost:14921/ws`. The browser extension simply connects to this address. It's much easier to set up than "Native Messaging" (which requires hacking the OS registry).

### Child Process
Instead of compiling the complex Rust Engine into a JavaScript module (FFI), the SvelteKit backend runs the compiled Rust executable (`veloce_core.exe`) exactly like you would run a command in the terminal. This is called spawning a **Child Process**. If the Rust engine crashes due to a bad network request, your SvelteKit dashboard stays safely alive and can restart it.

### Multi-Threading (Tokio)
When downloading a large file (Plan A), the Rust engine asks the server "Can I download this in pieces?" (Accept-Ranges). If yes, Rust uses `Tokio` to spawn multiple asynchronous tasks. Each task downloads a different 10% of the file simultaneously, and writes it directly to the disk, dramatically speeding up the download.
