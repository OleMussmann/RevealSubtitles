
/**
 * Speech-to-Text Plugin for Reveal.js
 * Real-time transcription via WhisperLive (Docker)
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
            debug: config.debug || false,
            repoUrl: config.repoUrl || "https://github.com/oliverk/speech-to-text" // Default to a likely repo or placeholder
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
            background: rgba(0, 0, 0, 0.6);
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
        
        // Default Icon (Mic Off / Idle)
        const iconMic = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        const iconStop = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        
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
        settingsBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 123 124.4" fill="white"><defs><clipPath id="gear-clip"><path d="M0 0h123v124.4H0z m86.5 62.2a25.9 25.9 0 0 0-25.9-25.9 25.9 25.9 0 0 0-25.9 25.9 25.9 25.9 0 0 0 25.9 25.9 25.9 25.9 0 0 0 25.9-25.9z"/></clipPath></defs><path clip-path="url(#gear-clip)" d="M61.5 0a65.5 62.2 0 0 0-11.4 1l-4.1 19.1a46.9 44.6 0 0 0-15.2 8.3L11.3 22.2A65.5 62.2 0 0 0 0 40.9l15.4 12.9a46.9 44.6 0 0 0-.9 8.3 46.9 44.6 0 0 0 .9 8.3L0 83.4a65.5 62.2 0 0 0 11.4 18.7l19.5-6.2a46.9 44.6 0 0 0 15.2 8.3l4.1 19.1a65.5 62.2 0 0 0 11.4 1 65.5 62.2 0 0 0 11.4-1l4.1-19.1a46.9 44.6 0 0 0 15.2-8.3l19.5 6.2a65.5 62.2 0 0 0 11.4-18.7L107.7 70.5a46.9 44.6 0 0 0 .9-8.3 46.9 44.6 0 0 0-.8-8.4l15.4-12.9a65.5 62.2 0 0 0-11.3-18.7l-19.5 6.2a46.9 44.6 0 0 0-15.2-8.4L73 1a65.5 62.2 0 0 0-11.4-.9z"/></svg>`;
        
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
                                `<a href="${options.repoUrl}" target="_blank" style="${linkStyle}">See README for setup instructions</a>`;
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
            controlBtn.style.background = '#dc3545'; // Red
            controlBtn.innerHTML = iconStop;
            
            // Ensure visual state is correct
            overlay.style.display = 'flex';
            setTimeout(() => overlay.style.opacity = '1', 10);
            
            shouldBeListening = true;
            finalSpan.innerText = "";
            interimSpan.innerText = "";
            initWhisperLive();
        };

        const stopListening = () => {
            controlBtn.style.background = 'rgba(0, 0, 0, 0.6)'; // Normal
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
