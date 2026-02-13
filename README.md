# RevealSubtitles

A [Reveal.js](https://revealjs.com/) plugin that adds real-time, auto-scrolling subtitles to your presentation. It supports two backends: the browser's built-in [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) (Chrome/Edge, no setup required) or OpenAI's Whisper model via [WhisperLive](https://github.com/collabora/WhisperLive) (requires Docker/Podman).

## Features

- **Real-time Transcription**: Low-latency speech-to-text.
- **Browser Mode**: Works out-of-the-box in Chrome/Edge using the built-in Web Speech API - no backend needed.
- **Whisper Mode**: Higher accuracy with punctuation via a local WhisperLive backend (Docker/Podman). Runs entirely on your hardware - no cloud API keys required.
- **Multiple Models**: Choose from `Browser (built-in)`, or Whisper models from `tiny.en` to `large-v3` depending on your hardware capabilities.
- **Multi-language Support**: Configure the language of your speech.
- **Zero-click operation**: Toggle with a hotkey.

## Prerequisites

- **Node.js** for running the presentation

### Optional
- **Chrome or Edge**: for the Browser backend - no additional setup needed

The following are only required for the Whisper backend:

- **Docker or Podman**: for running the WhisperLive transcription container
- **NVIDIA GPU**: recommended for best performance, but CPU mode is available

## Getting Started

### Browser Mode (Quick Start)

No backend setup is needed. Just install and run the presentation (see below), select `Browser (built-in)` from the Model dropdown, and start talking. This works in Chrome and Edge.

### Whisper Mode

The backend runs in a Docker or Podman container. You can choose between CPU and GPU modes. The examples below use `docker`; replace with `podman` if you prefer.

#### 1. Download the Compose File

Download the [docker-compose.yml](docker-compose.yml) file for CPU or [docker-compose-gpu.yml](docker-compose-gpu.yml) for (Nvidia) GPU. For more sophisticated setups check the [WhisperLive repository](https://github.com/collabora/WhisperLive?tab=readme-ov-file#whisper-live-server-in-docker). AMD GPUs are not supported yet, but will [probably come in the future](https://github.com/SYSTRAN/faster-whisper/issues/1370).

#### 2. Start the Transcription Backend

**Option A: CPU (Slower, works on any machine)**
```bash
docker compose up -d
```

**Option B: GPU (Fast, requires NVIDIA GPU & Container Toolkit)**
```bash
docker compose -f docker-compose-gpu.yml up -d
```

The backend will start listening on port `9090`. Edit the `ports` entry if you want a different one: `"NEW_PORT:9090"`

#### 3. Run the Presentation

Install dependencies and start the Reveal.js development server:

```bash
npm install
npm start
```

Open your browser to `http://localhost:8000`.

## Usage

### Controls

- **Press 'T'**: Cycle through the plugin states:
  1.  **Hidden**: Overlay is invisible.
  2.  **Shown**: Overlay is visible, status is "Ready".
  3.  **Listening**: Microphone is active, transcription is running.
- **Click the Mic Icon**: Toggle listening on/off.
- **Click the Gear Icon**: Open settings to configure:
  - **Model**: Select `Browser (built-in)` for zero-setup in-browser recognition, or a Whisper model (`tiny.en` through `large-v3`) for higher accuracy with punctuation. Larger Whisper models are more accurate but require more RAM/VRAM.
  - **Language**: Set the spoken language code (e.g., `en`, `de`, `fr`).
  - **Port**: Change the WhisperLive WebSocket port if needed (hidden when using Browser mode).

### Remote Whisper Backend (Port Forwarding)

If you are presenting on a laptop but want to run the heavy Whisper backend on a powerful remote server (e.g., a desktop with a GPU), you can forward the port via SSH.

1.  **On the Remote Server**:
    Start the Docker container (GPU mode recommended).

2.  **On your Laptop**:
    Run the following command to forward the remote port `9090` to your local machine:

    ```bash
    ssh -L 9090:localhost:9090 user@remote-server-ip
    ```

    *Replace `user@remote-server-ip` with your actual SSH login.*

3.  **In the Presentation**:
    Leave the port setting at `9090`. The plugin will connect to `localhost:9090`, which is securely tunneled to your remote server.

## Troubleshooting

- **"Backend not reachable"**: Ensure the Docker/Podman container is running (`docker compose ps` or `podman compose ps`) and that port `9090` is not blocked by a firewall.
- **"Browser speech recognition not supported"**: The Web Speech API is only available in Chrome and Edge. Use a Whisper model in other browsers.
- **Mic Error**: Ensure you have granted microphone permission to the browser. Note that modern browsers require HTTPS or `localhost` to access the microphone.
