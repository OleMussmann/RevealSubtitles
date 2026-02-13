
/**
 * Speech-to-Text Plugin for Reveal.js
 * Real-time transcription via WhisperLive (Docker)
 *
 * Icons: Font Awesome Free 7.2.0 by @fontawesome
 * License: https://fontawesome.com/license/free
 * Copyright 2026 Fonticons, Inc.
 */

const RevealSpeechText = {
    id: 'speech-text',
    init: (deck) => {
        
        // --- 1. Configuration ---
        const config = deck.getConfig().speechText || {};
        const options = {
            enabled: config.enabled || false, 
            language: config.language || 'en',
            model: config.model || 'small.en',
            port: config.port || 9090,
            debug: config.debug || false
        };

        // State
        // 0 = Hidden
        // 1 = Shown (Ready)
        // 2 = Listening
        let viewState = 0; 
        
        let isListening = false;
        let shouldBeListening = false;
        let localWorker = null; // WebSocket
        
        let audioContext = null;
        let processor = null;
        let source = null;
        let globalStream = null;

        // --- 2. Create UI Overlay ---
        const overlay = document.createElement('div');
        overlay.id = 'speech-text-overlay';
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
            #speech-text-overlay::-webkit-scrollbar { width: 8px; }
            #speech-text-overlay::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.1); border-radius: 4px; }
            #speech-text-overlay::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.3); border-radius: 4px; }
            #speech-text-overlay::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.5); }
            .speech-progress-bar { width: 100%; height: 4px; background: #444; margin-bottom: 10px; display: none; }
            .speech-progress-bar-fill { height: 100%; background: #007bff; width: 0%; transition: width 0.1s; }
            .speech-input-group { margin-bottom: 8px; }
            .speech-input-group label { display: block; font-size: 0.8em; color: #aaa; margin-bottom: 2px; }
            .speech-input-field { background: rgba(255,255,255,0.1); border: 1px solid #555; color: white; padding: 5px; border-radius: 4px; width: 100%; box-sizing: border-box; }
            .speech-input-field:focus { outline: none; border-color: #007bff; }
        `;
        document.head.appendChild(styleSheet);

        const progressBar = document.createElement('div');
        progressBar.className = 'speech-progress-bar';
        const progressFill = document.createElement('div');
        progressFill.className = 'speech-progress-bar-fill';
        progressBar.appendChild(progressFill);

        const statusText = document.createElement('div');
        statusText.style.fontSize = '0.5em';
        statusText.style.color = '#aaa';
        statusText.style.marginBottom = '5px';
        statusText.style.display = 'none';

        // --- Create Control Container ---
        const controlContainer = document.createElement('div');
        controlContainer.id = 'speech-control-container';
        controlContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 99999;
            font-family: sans-serif;
        `;

        // --- Settings Panel ---
        const settingsPanel = document.createElement('div');
        settingsPanel.id = 'speech-settings-panel';
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
        settingsPanel.addEventListener('keydown', (e) => e.stopPropagation());

        const createInput = (label, type, value, onChange) => {
            const group = document.createElement('div');
            group.className = 'speech-input-group';
            
            const lbl = document.createElement('label');
            lbl.innerText = label;
            
            let input;
            if (type === 'select') {
                input = document.createElement('select');
                value.forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt.value;
                    o.innerText = opt.label;
                    input.appendChild(o);
                });
            } else {
                input = document.createElement('input');
                input.type = 'text';
                input.value = value;
            }
            input.className = 'speech-input-field';
            input.addEventListener('change', onChange);
            
            group.appendChild(lbl);
            group.appendChild(input);
            return { group, input };
        };

        const restartConnection = () => {
            if (shouldBeListening && localWorker && localWorker.readyState === WebSocket.OPEN) {
                 try {
                     const encoder = new TextEncoder();
                     localWorker.send(encoder.encode("END_OF_AUDIO"));
                 } catch (err) { /* ignore */ }
                 localWorker.close(1000, "config change");
            }
        };

        const models = [
            { value: 'tiny.en', label: 'tiny.en (500Mb)' },
            { value: 'small.en', label: 'small.en (800Mb)' },
            { value: 'medium.en', label: 'medium.en (2.3Gb)' },
            { value: 'large-v3', label: 'large-v3 (4.2Gb)' }
        ];
        const modelControl = createInput('Model', 'select', models, (e) => {
            options.model = e.target.value;
            restartConnection();
        });
        modelControl.input.value = options.model;
        settingsPanel.appendChild(modelControl.group);

        const langControl = createInput('Language (e.g. en, de)', 'text', options.language, (e) => {
            options.language = e.target.value;
            restartConnection();
        });
        settingsPanel.appendChild(langControl.group);

        const portControl = createInput('Port', 'text', options.port, (e) => {
            options.port = parseInt(e.target.value) || 9090;
            restartConnection();
        });
        settingsPanel.appendChild(portControl.group);

        controlContainer.appendChild(settingsPanel);

        // --- Toggle Button (Mic) ---
        const controlBtn = document.createElement('div');
        controlBtn.id = 'speech-text-control';
        controlBtn.title = 'Toggle Speech Recognition';
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
        
        controlBtn.addEventListener('click', () => {
            // Manual click toggles Listening state
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
        controlBtn.onmouseover = () => controlBtn.style.transform = 'scale(1.1)';
        controlBtn.onmouseout = () => controlBtn.style.transform = 'scale(1.0)';
        
        // --- Settings Toggle Button (Gear) ---
        const settingsBtn = document.createElement('div');
        settingsBtn.title = 'Settings';
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
        
        settingsBtn.addEventListener('click', () => {
             const isHidden = settingsPanel.style.display === 'none';
             settingsPanel.style.display = isHidden ? 'flex' : 'none';
        });
        settingsBtn.onmouseover = () => settingsBtn.style.transform = 'scale(1.1)';
        settingsBtn.onmouseout = () => settingsBtn.style.transform = 'scale(1.0)';

        controlContainer.appendChild(controlBtn);
        controlContainer.appendChild(settingsBtn);
        controlContainer.style.display = 'none'; // Hidden by default until T is pressed
        document.body.appendChild(controlContainer);

        const content = document.createElement('div');
        content.id = 'speech-text-content';
        content.style.textShadow = '2px 2px 4px rgba(0,0,0,0.8)';
        
        const finalSpan = document.createElement('span');
        finalSpan.style.color = '#eee';
        
        const interimSpan = document.createElement('span');
        interimSpan.style.color = '#aaa';
        interimSpan.style.fontStyle = 'italic';

        overlay.appendChild(statusText);
        overlay.appendChild(progressBar);
        content.appendChild(finalSpan);
        content.appendChild(interimSpan);
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        // --- 3. WhisperLive Logic ---
        
        let connectSocket = () => {};

        let _aaFilterCache = null;

        const buildLowPassFilter = (sampleRate, cutoff, numTaps) => {
            const kernel = new Float32Array(numTaps);
            const mid = (numTaps - 1) / 2;
            const normCutoff = cutoff / sampleRate;
            let sum = 0;
            for (let i = 0; i < numTaps; i++) {
                const x = i - mid;
                const sinc = (x === 0)
                    ? 2 * Math.PI * normCutoff
                    : Math.sin(2 * Math.PI * normCutoff * x) / x;
                const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (numTaps - 1))
                             + 0.08 * Math.cos(4 * Math.PI * i / (numTaps - 1));
                kernel[i] = sinc * window;
                sum += kernel[i];
            }
            for (let i = 0; i < numTaps; i++) kernel[i] /= sum;
            return kernel;
        };

        const downsampleBuffer = (buffer, sampleRate, outSampleRate = 16000) => {
            if (outSampleRate === sampleRate) return buffer;
            if (outSampleRate > sampleRate) throw "downsampling rate must be smaller than original sample rate";

            if (!_aaFilterCache || _aaFilterCache.sampleRate !== sampleRate) {
                const numTaps = 63;
                const cutoff = outSampleRate * 0.45;
                _aaFilterCache = {
                    sampleRate,
                    kernel: buildLowPassFilter(sampleRate, cutoff, numTaps),
                    numTaps
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
            let whisperReady = false;
            let connectFailures = 0;
            let hasConnectedOnce = false;
            
            connectSocket = () => {
                if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

                whisperReady = false;
                socket = new WebSocket(wsUrl);
                localWorker = socket;
                
                socket.onopen = () => {
                    connectFailures = 0;
                    hasConnectedOnce = true;
                    statusText.innerText = "Loading model...";
                    statusText.style.color = '#fff';
                    
                    socket.send(JSON.stringify({
                        uid: "client-" + Math.random().toString(36).substring(7),
                        language: options.language,
                        task: "transcribe",
                        model: options.model,
                        use_vad: true,
                        initial_prompt: config.initialPrompt || null,
                        no_speech_thresh: 0.5
                    }));
                };

                socket.onclose = () => {
                    localWorker = null;
                    whisperReady = false;
                    if (shouldBeListening) {
                        connectFailures++;
                        const delay = Math.min(2000 * Math.pow(2, connectFailures - 1), 10000);

                        if (!hasConnectedOnce && connectFailures >= 2) {
                            const linkStyle = 'color:#6cf;text-decoration:underline;cursor:pointer';
                            statusText.innerHTML =
                                `Backend not reachable on port ${options.port}.<br>` +
                                `<a href="https://github.com/OleMussmann/RevealSubtitles" target="_blank" style="${linkStyle}">See README for setup instructions</a>`;
                            statusText.style.color = '#f88';
                        } else {
                            statusText.innerText = "Reconnecting...";
                            statusText.style.color = '#ff8';
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
                            whisperReady = true;
                            statusText.innerText = "Connected (" + options.model + ")";
                            statusText.style.color = '#fff';
                            progressBar.style.display = 'none';
                            return;
                        }
                        if (data.message === "DISCONNECT") {
                            statusText.innerText = "Session expired. Reconnecting...";
                            statusText.style.color = '#ff8';
                            return;
                        }
                        if (data.status === "WAIT") {
                            statusText.innerText = "Server busy, waiting...";
                            statusText.style.color = '#ff8';
                            return;
                        }
                        if (data.status === "ERROR" || data.status === "WARNING") {
                            statusText.innerText = data.status + ": " + (data.message || "unknown");
                            statusText.style.color = data.status === "ERROR" ? '#f88' : '#ff8';
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
            statusText.style.display = 'block';
            progressBar.style.display = 'block';
            progressFill.style.width = '0%'; 
            
            connectSocket();
            
            if (!audioContext || audioContext.state === 'closed') {
                 startAudioCapture();
            }
        };

        // --- 4. Audio Capture ---
        const startAudioCapture = async () => {
             try {
                if (audioContext && audioContext.state === 'closed') {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                } else if (!audioContext) {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }

                globalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const sampleRate = audioContext.sampleRate;
                
                source = audioContext.createMediaStreamSource(globalStream);
                const bufferSize = 4096; 
                processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

                processor.onaudioprocess = (e) => {
                    if (!isListening) return;
                    
                    const inputData = e.inputBuffer.getChannelData(0);
                    
                    let sum = 0;
                    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                    const rms = Math.sqrt(sum / inputData.length);
                    
                    if (rms > 0.02) { 
                        if (!localWorker || localWorker.readyState !== WebSocket.OPEN) {
                             if (shouldBeListening) connectSocket();
                        }
                    }

                    const downsampled = downsampleBuffer(inputData, sampleRate, 16000);
                    if (localWorker && localWorker.readyState === WebSocket.OPEN) {
                         localWorker.send(downsampled.buffer);
                    }
                };

                source.connect(processor);
                processor.connect(audioContext.destination);
                isListening = true;

            } catch (err) {
                console.error("Mic Error:", err);
                statusText.innerText = "Mic Error: " + err.message;
            }
        };

        const stopLocal = () => {
            if (globalStream) globalStream.getTracks().forEach(t => t.stop());
            if (audioContext && audioContext.state !== 'closed') audioContext.close();
            if (processor) processor.disconnect();
            if (source) source.disconnect();
            if (localWorker) {
                 if (localWorker.readyState === WebSocket.OPEN) {
                     try {
                         const encoder = new TextEncoder();
                         localWorker.send(encoder.encode("END_OF_AUDIO"));
                     } catch (e) { }
                 }
                 localWorker.close();
                 localWorker = null;
            }
            isListening = false;
        };

        // --- 5. Logic Control ---
        
        const startListening = () => {
            controlBtn.style.background = 'rgba(0, 0, 0, 0.6)';
            controlBtn.innerHTML = iconPause;
            
            // Ensure visual state is correct
            overlay.style.display = 'flex';
            setTimeout(() => overlay.style.opacity = '1', 10);
            
            shouldBeListening = true;
            finalSpan.innerText = "";
            interimSpan.innerText = "";
            initWhisperLive();
        };

        const stopListening = () => {
            controlBtn.style.background = '#dc3545';
            controlBtn.innerHTML = iconMic;
            
            shouldBeListening = false;
            stopLocal();
            // Note: We do NOT hide overlay here unless we transition to Hidden state
            statusText.innerText = "Paused.";
            statusText.style.color = '#aaa';
        };

        // Main Toggle Logic (T Key)
        // Cycle: Hidden -> Shown -> Listening -> Hidden
        const toggleCycle = () => {
            if (viewState === 0) {
                // Hidden -> Shown
                viewState = 1;
                controlContainer.style.display = 'flex';
                overlay.style.display = 'flex';
                setTimeout(() => overlay.style.opacity = '1', 10);
                statusText.innerText = "Ready. Press 'T' to start.";
                statusText.style.display = 'block';
                statusText.style.color = '#aaa';
            } else if (viewState === 1) {
                // Shown -> Listening
                viewState = 2;
                startListening();
            } else {
                // Listening -> Hidden
                viewState = 0;
                stopListening();
                settingsPanel.style.display = 'none';
                controlContainer.style.display = 'none';
                overlay.style.opacity = '0';
                setTimeout(() => overlay.style.display = 'none', 300);
            }
        };

        // 6. Register Keyboard Shortcut
        deck.addKeyBinding({ keyCode: 84, key: 'T', description: 'Toggle Speech-to-Text' }, () => {
            toggleCycle();
        });

        // Expose API
        return { 
            start: startListening, 
            stop: stopListening, 
            toggle: toggleCycle, 
            isListening: () => isListening 
        };
    }
};

export default RevealSpeechText;
