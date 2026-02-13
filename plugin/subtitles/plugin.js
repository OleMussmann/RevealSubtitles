/**
 * Speech-to-Text Plugin for Reveal.js
 * Real-time transcription via WhisperLive (Docker) or Browser Speech API
 *
 * Icons: Font Awesome Free 7.2.0 by @fontawesome
 * License: https://fontawesome.com/license/free
 * Copyright 2026 Fonticons, Inc.
 */

const RevealSubtitles = {
  id: "subtitles",
  init: (deck) => {
    // --- 1. Configuration ---
    const config = deck.getConfig().speechText || {};
    const options = {
      language: config.language || "en",
      model: config.model || "small.en",
      port: config.port || 9090,
    };

    // Shared encoder for sending END_OF_AUDIO signals
    const textEncoder = new TextEncoder();

    // State
    // 0 = Hidden
    // 1 = Shown (Ready)
    // 2 = Listening
    let viewState = 0;

    let isListening = false;
    let shouldBeListening = false;
    let ws = null; // WebSocket connection

    let audioContext = null;
    let workletNode = null;
    let source = null;
    let globalStream = null;

    // --- 2. Create UI Overlay ---
    const overlay = document.createElement("div");
    overlay.id = "subtitles-overlay";
    overlay.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            width: 80%;
            max-width: 1200px;
            height: auto;
            max-height: 150px;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(5px);
            padding: 15px 25px;
            border-radius: 10px;
            font-size: 1.5rem;
            line-height: 1.3;
            color: #fff;
            text-align: center;
            pointer-events: auto;
            overflow-y: auto;
            display: none; 
            flex-direction: column;
            justify-content: flex-start;
            transition: opacity 0.3s ease;
            z-index: 9999;
            font-family: sans-serif;
        `;

    const styleSheet = document.createElement("style");
    styleSheet.innerText = `
            #subtitles-overlay::-webkit-scrollbar { width: 8px; }
            #subtitles-overlay::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.1); border-radius: 4px; }
            #subtitles-overlay::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.3); border-radius: 4px; }
            #subtitles-overlay::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.5); }
            .speech-input-group { margin-bottom: 8px; }
            .speech-input-group label { display: block; font-size: 0.8em; color: #aaa; margin-bottom: 2px; }
            .speech-input-field { background: rgba(255,255,255,0.1); border: 1px solid #555; color: white; padding: 5px; border-radius: 4px; width: 100%; box-sizing: border-box; }
            .speech-input-field:focus { outline: none; border-color: #007bff; }
            .speech-input-field option { background: #222; color: white; }
        `;
    document.head.appendChild(styleSheet);

    const statusText = document.createElement("div");
    statusText.style.fontSize = "0.5em";
    statusText.style.color = "#aaa";
    statusText.style.marginBottom = "5px";
    statusText.style.display = "none";

    // --- Create Control Container ---
    const controlContainer = document.createElement("div");
    controlContainer.id = "speech-control-container";
    controlContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            display: none;
            align-items: center;
            gap: 10px;
            z-index: 99999;
            font-family: sans-serif;
        `;

    // --- Settings Panel ---
    const settingsPanel = document.createElement("div");
    settingsPanel.id = "speech-settings-panel";
    settingsPanel.style.cssText = `
            position: absolute;
            bottom: 60px;
            left: 0;
            background: rgba(0, 0, 0, 0.9);
            backdrop-filter: blur(5px);
            padding: 15px;
            border-radius: 8px;
            display: none;
            flex-direction: column;
            width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        `;
    settingsPanel.addEventListener("keydown", (e) => e.stopPropagation());

    const createInput = (label, type, value, onChange) => {
      const group = document.createElement("div");
      group.className = "speech-input-group";

      const lbl = document.createElement("label");
      lbl.innerText = label;

      let input;
      if (type === "select") {
        input = document.createElement("select");
        value.forEach((opt) => {
          const o = document.createElement("option");
          o.value = opt.value;
          o.innerText = opt.label;
          input.appendChild(o);
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = value;
      }
      input.className = "speech-input-field";
      input.addEventListener("change", onChange);

      group.appendChild(lbl);
      group.appendChild(input);
      return { group, input };
    };

    const restartConnection = () => {
      if (!shouldBeListening) return;
      // Stop whichever backend is currently active
      stopBrowserSpeech();
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(textEncoder.encode("END_OF_AUDIO"));
        } catch (err) {
          /* ignore */
        }
        ws.close(1000, "config change");
      }
      stopLocal();
      // Restart with the (possibly new) backend
      finalSpan.innerText = "";
      interimSpan.innerText = "";
      if (options.model === "browser") {
        initBrowserSpeech();
      } else {
        initWhisperLive();
      }
    };

    const hasBrowserSpeech = !!(
      window.SpeechRecognition || window.webkitSpeechRecognition
    );
    const models = [
      ...(hasBrowserSpeech
        ? [{ value: "browser", label: "Browser (built-in)" }]
        : []),
      { value: "tiny.en", label: "tiny.en (Whisper, 500Mb)" },
      { value: "small.en", label: "small.en (Whisper, 800Mb)" },
      { value: "medium.en", label: "medium.en (Whisper, 2.3Gb)" },
      { value: "large-v3", label: "large-v3 (Whisper, 4.2Gb)" },
    ];
    const modelControl = createInput("Model", "select", models, (e) => {
      options.model = e.target.value;
      updateSettingsVisibility();
      restartConnection();
    });
    modelControl.input.value = options.model;
    settingsPanel.appendChild(modelControl.group);

    const langControl = createInput(
      "Language (e.g. en, de)",
      "text",
      options.language,
      (e) => {
        options.language = e.target.value;
        restartConnection();
      },
    );
    settingsPanel.appendChild(langControl.group);

    const portControl = createInput("Port", "text", options.port, (e) => {
      options.port = parseInt(e.target.value) || 9090;
      restartConnection();
    });
    settingsPanel.appendChild(portControl.group);

    const updateSettingsVisibility = () => {
      const isBrowser = options.model === "browser";
      portControl.group.style.display = isBrowser ? "none" : "block";
    };
    updateSettingsVisibility();

    controlContainer.appendChild(settingsPanel);

    // --- Toggle Button (Mic) ---
    const controlBtn = document.createElement("div");
    controlBtn.id = "subtitles-control";
    controlBtn.title = "Toggle Speech Recognition";
    controlBtn.style.cssText = `
            width: 50px;
            height: 50px;
            background: #dc3545;
            backdrop-filter: blur(5px);
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 20px;
            transition: all 0.2s ease;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        `;

    // FontAwesome icons (Font Awesome Free 7.2.0, https://fontawesome.com/license/free)
    const iconMic = `<svg width="20" height="24" viewBox="0 0 384 512" fill="currentColor"><path d="M192 0C139 0 96 43 96 96l0 128c0 53 43 96 96 96s96-43 96-96l0-128c0-53-43-96-96-96zM48 184c0-13.3-10.7-24-24-24S0 170.7 0 184l0 40c0 97.9 73.3 178.7 168 190.5l0 49.5-48 0c-13.3 0-24 10.7-24 24s10.7 24 24 24l144 0c13.3 0 24-10.7 24-24s-10.7-24-24-24l-48 0 0-49.5c94.7-11.8 168-92.6 168-190.5l0-40c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 40c0 79.5-64.5 144-144 144S48 303.5 48 224l0-40z"/></svg>`;
    const iconPause = `<svg width="24" height="24" viewBox="0 0 512 512" fill="currentColor"><path d="M256 512a256 256 0 1 0 0-512 256 256 0 1 0 0 512zM224 192l0 128c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-128c0-17.7 14.3-32 32-32s32 14.3 32 32zm128 0l0 128c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-128c0-17.7 14.3-32 32-32s32 14.3 32 32z"/></svg>`;

    controlBtn.innerHTML = iconMic;

    controlBtn.addEventListener("click", () => {
      if (viewState === 2) {
        // Listening -> Shown (Ready)
        viewState = 1;
        stopListening();
      } else {
        // Hidden/Shown -> Listening
        viewState = 2;
        startListening();
      }
    });
    controlBtn.onmouseover = () => (controlBtn.style.transform = "scale(1.1)");
    controlBtn.onmouseout = () => (controlBtn.style.transform = "scale(1.0)");

    // --- Settings Toggle Button (Gear) ---
    const settingsBtn = document.createElement("div");
    settingsBtn.title = "Settings";
    settingsBtn.style.cssText = `
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(5px);
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 18px;
            transition: all 0.2s ease;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        `;
    settingsBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor"><path d="M259.1 73.5C262.1 58.7 275.2 48 290.4 48L350.2 48C365.4 48 378.5 58.7 381.5 73.5L396 143.5C410.1 149.5 423.3 157.2 435.3 166.3L503.1 143.8C517.5 139 533.3 145 540.9 158.2L570.8 210C578.4 223.2 575.7 239.8 564.3 249.9L511 297.3C511.9 304.7 512.3 312.3 512.3 320C512.3 327.7 511.8 335.3 511 342.7L564.4 390.2C575.8 400.3 578.4 417 570.9 430.1L541 481.9C533.4 495 517.6 501.1 503.2 496.3L435.4 473.8C423.3 482.9 410.1 490.5 396.1 496.6L381.7 566.5C378.6 581.4 365.5 592 350.4 592L290.6 592C275.4 592 262.3 581.3 259.3 566.5L244.9 496.6C230.8 490.6 217.7 482.9 205.6 473.8L137.5 496.3C123.1 501.1 107.3 495.1 99.7 481.9L69.8 430.1C62.2 416.9 64.9 400.3 76.3 390.2L129.7 342.7C128.8 335.3 128.4 327.7 128.4 320C128.4 312.3 128.9 304.7 129.7 297.3L76.3 249.8C64.9 239.7 62.3 223 69.8 209.9L99.7 158.1C107.3 144.9 123.1 138.9 137.5 143.7L205.3 166.2C217.4 157.1 230.6 149.5 244.6 143.4L259.1 73.5zM320.3 400C364.5 399.8 400.2 363.9 400 319.7C399.8 275.5 363.9 239.8 319.7 240C275.5 240.2 239.8 276.1 240 320.3C240.2 364.5 276.1 400.2 320.3 400z"/></svg>`;

    settingsBtn.addEventListener("click", () => {
      const isHidden = settingsPanel.style.display === "none";
      settingsPanel.style.display = isHidden ? "flex" : "none";
    });
    settingsBtn.onmouseover = () =>
      (settingsBtn.style.transform = "scale(1.1)");
    settingsBtn.onmouseout = () => (settingsBtn.style.transform = "scale(1.0)");

    controlContainer.appendChild(controlBtn);
    controlContainer.appendChild(settingsBtn);
    document.body.appendChild(controlContainer);

    const content = document.createElement("div");
    content.id = "subtitles-content";
    content.style.textShadow = "2px 2px 4px rgba(0,0,0,0.8)";

    const finalSpan = document.createElement("span");
    finalSpan.style.color = "#eee";

    const interimSpan = document.createElement("span");
    interimSpan.style.color = "#aaa";
    interimSpan.style.fontStyle = "italic";

    overlay.appendChild(statusText);
    content.appendChild(finalSpan);
    content.appendChild(interimSpan);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // --- 3a. Browser Speech Recognition (Web Speech API) ---
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;

    const initBrowserSpeech = () => {
      if (!SpeechRecognition) {
        statusText.innerText = "Browser speech recognition not supported.";
        statusText.style.color = "#f88";
        statusText.style.display = "block";
        return;
      }

      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = options.language;

      let finalTranscript = "";

      recognition.onstart = () => {
        statusText.innerText = "Listening (Browser)...";
        statusText.style.color = "#fff";
        statusText.style.display = "block";
        isListening = true;
      };

      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript + " ";
          } else {
            interim += transcript;
          }
        }
        finalSpan.innerText = finalTranscript;
        interimSpan.innerText = interim;
        overlay.scrollTop = overlay.scrollHeight;
      };

      recognition.onerror = (event) => {
        if (event.error === "no-speech") return;
        if (event.error === "aborted") return;
        console.warn("Browser Speech Error:", event.error);
        statusText.innerText = "Speech error: " + event.error;
        statusText.style.color = "#f88";
      };

      recognition.onend = () => {
        isListening = false;
        // Auto-restart if we should still be listening
        // (browser speech recognition stops after silence or errors)
        if (recognition && shouldBeListening && options.model === "browser") {
          try {
            recognition.start();
          } catch (e) {
            /* already started */
          }
        }
      };

      statusText.innerText = "Starting...";
      statusText.style.display = "block";
      statusText.style.color = "#fff";
      recognition.start();
    };

    const stopBrowserSpeech = () => {
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {
          /* ignore */
        }
        recognition = null;
      }
      isListening = false;
    };

    // --- 3b. WhisperLive Logic ---

    let connectSocket = () => {};

    // --- Helper: Anti-aliased Downsampler (44/48kHz -> 16kHz) ---
    // Uses a windowed-sinc low-pass FIR filter before decimation
    // to prevent aliasing artifacts that corrupt speech features.
    let _aaFilterCache = null;

    const buildLowPassFilter = (sampleRate, cutoff, numTaps) => {
      const kernel = new Float32Array(numTaps);
      const mid = (numTaps - 1) / 2;
      const normCutoff = cutoff / sampleRate;
      let sum = 0;
      for (let i = 0; i < numTaps; i++) {
        const x = i - mid;
        const sinc =
          x === 0
            ? 2 * Math.PI * normCutoff
            : Math.sin(2 * Math.PI * normCutoff * x) / x;
        const window =
          0.42 -
          0.5 * Math.cos((2 * Math.PI * i) / (numTaps - 1)) +
          0.08 * Math.cos((4 * Math.PI * i) / (numTaps - 1));
        kernel[i] = sinc * window;
        sum += kernel[i];
      }
      for (let i = 0; i < numTaps; i++) kernel[i] /= sum;
      return kernel;
    };

    const downsampleBuffer = (buffer, sampleRate, outSampleRate = 16000) => {
      if (outSampleRate === sampleRate) return buffer;
      if (outSampleRate > sampleRate)
        throw "downsampling rate must be smaller than original sample rate";

      if (!_aaFilterCache || _aaFilterCache.sampleRate !== sampleRate) {
        const numTaps = 63;
        const cutoff = outSampleRate * 0.45;
        _aaFilterCache = {
          sampleRate,
          kernel: buildLowPassFilter(sampleRate, cutoff, numTaps),
          numTaps,
        };
      }
      const { kernel, numTaps } = _aaFilterCache;
      const halfTaps = (numTaps - 1) / 2;

      const ratio = sampleRate / outSampleRate;
      const newLength = Math.round(buffer.length / ratio);
      const result = new Float32Array(newLength);

      for (let j = 0; j < newLength; j++) {
        const center = Math.round(j * ratio);
        let sample = 0;
        for (let k = 0; k < numTaps; k++) {
          const idx = center + k - halfTaps;
          if (idx >= 0 && idx < buffer.length) {
            sample += buffer[idx] * kernel[k];
          }
        }
        result[j] = sample;
      }
      return result;
    };

    const initWhisperLive = () => {
      const wsUrl = `ws://localhost:${options.port}`;
      let socket = null;
      let connectFailures = 0;
      let hasConnectedOnce = false;

      connectSocket = () => {
        if (
          socket &&
          (socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING)
        )
          return;

        socket = new WebSocket(wsUrl);
        ws = socket;

        socket.onopen = () => {
          connectFailures = 0;
          hasConnectedOnce = true;
          statusText.innerText = "Loading model...";
          statusText.style.color = "#fff";

          socket.send(
            JSON.stringify({
              uid: "client-" + Math.random().toString(36).substring(7),
              language: options.language,
              task: "transcribe",
              model: options.model,
              use_vad: true,
              initial_prompt: config.initialPrompt || null,
              no_speech_thresh: 0.5,
            }),
          );
        };

        socket.onclose = () => {
          ws = null;
          if (shouldBeListening) {
            connectFailures++;
            const delay = Math.min(
              2000 * Math.pow(2, connectFailures - 1),
              10000,
            );

            if (!hasConnectedOnce && connectFailures >= 2) {
              const linkStyle =
                "color:#6cf;text-decoration:underline;cursor:pointer";
              statusText.innerHTML =
                `Backend not reachable on port ${options.port}.<br>` +
                `<a href="https://github.com/OleMussmann/RevealSubtitles/README.md#getting-started" target="_blank" style="${linkStyle}">See README for setup instructions</a>`;
              statusText.style.color = "#f88";
            } else {
              statusText.innerText = "Reconnecting...";
              statusText.style.color = "#ff8";
            }
            setTimeout(() => {
              if (shouldBeListening) connectSocket();
            }, delay);
          } else {
            statusText.innerText = "Disconnected.";
          }
        };

        socket.onerror = (error) => {
          console.warn("WhisperLive Socket Error:", error);
        };

        socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);

            if (data.message === "SERVER_READY") {
              statusText.innerText = "Connected (" + options.model + ")";
              statusText.style.color = "#fff";
              return;
            }
            if (data.message === "DISCONNECT") {
              statusText.innerText = "Session expired. Reconnecting...";
              statusText.style.color = "#ff8";
              return;
            }
            if (data.status === "WAIT") {
              statusText.innerText = "Server busy, waiting...";
              statusText.style.color = "#ff8";
              return;
            }
            if (data.status === "ERROR" || data.status === "WARNING") {
              statusText.innerText =
                data.status + ": " + (data.message || "unknown");
              statusText.style.color =
                data.status === "ERROR" ? "#f88" : "#ff8";
              return;
            }

            if (data.segments) {
              let completedText = "";
              let pendingText = "";
              for (const segment of data.segments) {
                if (segment.completed === false) {
                  pendingText += segment.text + " ";
                } else {
                  completedText += segment.text + " ";
                }
              }
              finalSpan.innerText = completedText;
              interimSpan.innerText = pendingText;
              overlay.scrollTop = overlay.scrollHeight;
            }
          } catch (e) {
            console.error("Invalid JSON:", event.data);
          }
        };
      };

      statusText.innerText = "Connecting...";
      statusText.style.display = "block";

      connectSocket();

      if (!audioContext || audioContext.state === "closed") {
        startAudioCapture();
      }
    };

    // --- 4. Audio Capture ---
    // AudioWorklet processor code as a Blob URL (avoids a separate file)
    const workletCode = `
            class DownsampleProcessor extends AudioWorkletProcessor {
                process(inputs) {
                    const input = inputs[0];
                    if (input.length > 0 && input[0].length > 0) {
                        this.port.postMessage(input[0]);
                    }
                    return true;
                }
            }
            registerProcessor('downsample-processor', DownsampleProcessor);
        `;
    const workletBlob = new Blob([workletCode], {
      type: "application/javascript",
    });
    const workletUrl = URL.createObjectURL(workletBlob);

    const startAudioCapture = async () => {
      try {
        if (!audioContext || audioContext.state === "closed") {
          audioContext = new (
            window.AudioContext || window.webkitAudioContext
          )();
        }

        await audioContext.audioWorklet.addModule(workletUrl);

        globalStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const sampleRate = audioContext.sampleRate;

        source = audioContext.createMediaStreamSource(globalStream);
        workletNode = new AudioWorkletNode(
          audioContext,
          "downsample-processor",
        );

        workletNode.port.onmessage = (e) => {
          if (!isListening) return;

          const inputData = e.data;

          // VAD (RMS) - reconnect if socket dropped
          let sum = 0;
          for (let i = 0; i < inputData.length; i++)
            sum += inputData[i] * inputData[i];
          const rms = Math.sqrt(sum / inputData.length);

          if (rms > 0.02) {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              if (shouldBeListening) connectSocket();
            }
          }

          const downsampled = downsampleBuffer(inputData, sampleRate, 16000);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(downsampled.buffer);
          }
        };

        source.connect(workletNode);
        workletNode.connect(audioContext.destination);
        isListening = true;
      } catch (err) {
        console.error("Mic Error:", err);
        statusText.innerText = "Mic Error: " + err.message;
      }
    };

    const stopLocal = () => {
      if (globalStream) globalStream.getTracks().forEach((t) => t.stop());
      if (audioContext && audioContext.state !== "closed") audioContext.close();
      if (workletNode) workletNode.disconnect();
      if (source) source.disconnect();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(textEncoder.encode("END_OF_AUDIO"));
          } catch (e) {}
        }
        ws.close();
        ws = null;
      }
      isListening = false;
    };

    // --- 5. Logic Control ---

    const startListening = () => {
      controlBtn.style.background = "rgba(0, 0, 0, 0.6)";
      controlBtn.innerHTML = iconPause;
      settingsPanel.style.display = "none";

      overlay.style.display = "flex";
      setTimeout(() => (overlay.style.opacity = "1"), 10);

      shouldBeListening = true;
      finalSpan.innerText = "";
      interimSpan.innerText = "";
      if (options.model === "browser") {
        initBrowserSpeech();
      } else {
        initWhisperLive();
      }
    };

    const stopListening = () => {
      controlBtn.style.background = "#dc3545";
      controlBtn.innerHTML = iconMic;

      shouldBeListening = false;
      stopBrowserSpeech();
      stopLocal();
      statusText.innerText = "Paused.";
      statusText.style.color = "#aaa";
    };

    // Main Toggle Logic (T Key)
    // Cycle: Hidden -> Shown -> Listening -> Hidden
    const toggleCycle = () => {
      if (viewState === 0) {
        // Hidden -> Shown
        viewState = 1;
        controlContainer.style.display = "flex";
        overlay.style.display = "flex";
        setTimeout(() => (overlay.style.opacity = "1"), 10);
        statusText.innerText = "Ready. Press 'T' to start.";
        statusText.style.display = "block";
        statusText.style.color = "#aaa";
      } else if (viewState === 1) {
        // Shown -> Listening
        viewState = 2;
        startListening();
      } else {
        // Listening -> Hidden
        viewState = 0;
        stopListening();
        settingsPanel.style.display = "none";
        controlContainer.style.display = "none";
        overlay.style.opacity = "0";
        setTimeout(() => (overlay.style.display = "none"), 300);
      }
    };

    // 6. Register Keyboard Shortcut
    deck.addKeyBinding(
      { keyCode: 84, key: "T", description: "Toggle Speech-to-Text" },
      () => {
        toggleCycle();
      },
    );

    // Expose API
    return {
      start: startListening,
      stop: stopListening,
      toggle: toggleCycle,
      isListening: () => isListening,
    };
  },
};

export default RevealSubtitles;
