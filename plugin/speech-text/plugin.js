
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
            debug: config.debug || false
        };

        // State
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

        // --- Create Control Button ---
        const controlContainer = document.createElement('div');
        controlContainer.id = 'speech-control-container';
        controlContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            display: flex;
            align-items: center;
            z-index: 99999;
            font-family: sans-serif;
        `;

        const controlBtn = document.createElement('div');
        controlBtn.id = 'speech-text-control';
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
        controlBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        
        controlBtn.addEventListener('click', () => {
            toggle();
        });

        controlBtn.onmouseover = () => controlBtn.style.transform = 'scale(1.1)';
        controlBtn.onmouseout = () => controlBtn.style.transform = 'scale(1.0)';
        
        // --- Model Selector (Dropdown) ---
        const modelSelect = document.createElement('select');
        modelSelect.id = 'speech-text-model-select';
        
        // Prevent key events from bubbling up to Reveal.js
        modelSelect.addEventListener('keydown', (e) => e.stopPropagation());
        
        modelSelect.style.cssText = `
            margin-left: 10px;
            padding: 5px;
            border-radius: 5px;
            background: rgba(0, 0, 0, 0.6);
            color: white;
            border: 1px solid #444;
            font-size: 14px;
            cursor: pointer;
            outline: none;
        `;
        
        const models = [
            { value: 'tiny.en', label: 'tiny.en (ok quality, 500Mb RAM)' },
            { value: 'small.en', label: 'small.en (better quality, 800Mb RAM)' },
            { value: 'medium.en', label: 'medium.en (great quality, 2.3Gb RAM)' },
            { value: 'large-v3', label: 'large-v3 (best quality, 4.2Gb RAM)' }
        ];

        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.value;
            opt.innerText = m.label;
            modelSelect.appendChild(opt);
        });

        modelSelect.value = options.model;

        // Changing model requires reconnection
        modelSelect.addEventListener('change', (e) => {
            options.model = e.target.value;
            if (shouldBeListening) {
                // Gracefully close, then onclose handler will auto-reconnect with new model
                if (localWorker && localWorker.readyState === WebSocket.OPEN) {
                    try {
                        const encoder = new TextEncoder();
                        localWorker.send(encoder.encode("END_OF_AUDIO"));
                    } catch (err) { /* ignore */ }
                    localWorker.close(1000, "model change");
                }
            }
        });

        controlContainer.appendChild(controlBtn);
        controlContainer.appendChild(modelSelect);
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
            const wsUrl = 'ws://localhost:9090'; 
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
                        // Exponential backoff: 2s, 4s, 8s, max 10s
                        const delay = Math.min(2000 * Math.pow(2, connectFailures - 1), 10000);

                        if (!hasConnectedOnce && connectFailures >= 2) {
                            // Backend has never been reachable -- show setup instructions
                            const linkStyle = 'color:#6cf;text-decoration:underline;cursor:pointer';
                            const codeStyle = 'background:#333;padding:2px 6px;border-radius:3px;font-size:0.9em';
                            statusText.innerHTML =
                                'WhisperLive backend not reachable.<br>' +
                                'Download: ' +
                                '<a href="DUMMY_URL/docker-compose.yml" download style="' + linkStyle + '">CPU</a>' +
                                ' · ' +
                                '<a href="DUMMY_URL/docker-compose-gpu.yml" download style="' + linkStyle + '">GPU (NVIDIA)</a>' +
                                '<br>Then run: ' +
                                '<code style="' + codeStyle + '">docker compose up -d</code>';
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
                            console.warn("WhisperLive: server session expired, will auto-reconnect");
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
                            console.warn("WhisperLive server:", data.status, data.message);
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
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            
            // Connect eagerly to avoid losing first words
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
                    
                    // VAD (RMS) - reconnect if socket dropped
                    let sum = 0;
                    for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                    const rms = Math.sqrt(sum / inputData.length);
                    
                    if (rms > 0.02) { 
                        if (!localWorker || localWorker.readyState !== WebSocket.OPEN) {
                             if (shouldBeListening) connectSocket();
                        }
                    }

                    // Downsample and send
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
                 // Signal WhisperLive to finalize any buffered audio
                 if (localWorker.readyState === WebSocket.OPEN) {
                     try {
                         const encoder = new TextEncoder();
                         localWorker.send(encoder.encode("END_OF_AUDIO"));
                     } catch (e) { /* ignore send errors during teardown */ }
                 }
                 localWorker.close();
                 localWorker = null;
            }
            isListening = false;
        };

        // --- 5. Start / Stop / Toggle ---
        const start = () => {
            controlBtn.style.background = '#dc3545';
            controlBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
            modelSelect.style.display = 'none';
            
            shouldBeListening = true;
            finalSpan.innerText = "";
            interimSpan.innerText = "";
            initWhisperLive();
        };

        const stop = () => {
            controlBtn.style.background = 'rgba(0, 0, 0, 0.6)';
            controlBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
            modelSelect.style.display = '';
            
            shouldBeListening = false;
            stopLocal();
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 300);
        };

        const toggle = () => {
            if (shouldBeListening) stop();
            else start();
        };

        // 6. Register Keyboard Shortcut
        deck.addKeyBinding({ keyCode: 84, key: 'T', description: 'Toggle Speech-to-Text' }, () => {
            toggle();
        });

        return { start, stop, toggle, isListening: () => isListening };
    }
};

export default RevealSpeechText;
