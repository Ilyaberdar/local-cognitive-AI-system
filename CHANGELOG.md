# Changelog

## 0.1.1 — 2026-10-11

The first public release of Local Cognitive: private chats, agents and workflows with models on your own computer, or on your own GPU server through Remote.

### Desktop

- **macOS (Apple silicon).** Signed and notarized. New versions install from the app: the update button in the title bar, or Settings → About.
- **Windows (x64), new.**
  - Models run on any GPU through Vulkan. On a PC with an NVIDIA GPU, the app offers the CUDA build: about 515 MB, after NVIDIA's license.
  - The installer is not signed yet. Windows asks once (More info → Run anyway), and the app announces new versions with a link to this page.
- **Clearer model errors.** A model file that the bundled runtime cannot read now says why, for example a format made for a modified llama.cpp. The error can be dismissed.
- **Split models.** Models made of several GGUF files install and import.
- **GPU memory.** Models shows the GPU's memory beside RAM.
- **Server models in answers.** Answers from a server name the server's model.
- **Menus.** A click anywhere closes an open menu, the title bar included.

### Server (Linux)

- **Several NVIDIA GPUs.** The service sees every NVIDIA GPU: each one gets its device file when the service starts.
- **Install:**

  ```
  curl -fsSL https://github.com/Ilyaberdar/local-cognitive-AI-system/releases/latest/download/install.sh | sudo bash
  ```

- **Update:**

  ```
  sudo local-cognitive-server update
  ```
