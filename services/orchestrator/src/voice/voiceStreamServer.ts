import { WebSocket } from "ws";
import { sentimentAnalyzer, AcousticFeatures } from "./sentimentAnalyzer.js";
import { orchestrator } from "../core/orchestrator.js";
import { eventBus } from "../core/eventBus.js";
import { streamingTts } from "./streamingTts.js";

interface VoiceClientSession {
  socket: WebSocket;
  isSpeaking: boolean;
  activeTurnId: string;
  accumulatedPcm: Buffer[];
  lastAcousticFeatures: AcousticFeatures;
  interrupted: boolean;
}

export class VoiceStreamServer {
  private sessions = new Map<WebSocket, VoiceClientSession>();

  handleConnection(socket: WebSocket) {
    const session: VoiceClientSession = {
      socket,
      isSpeaking: false,
      activeTurnId: `turn_${Date.now()}`,
      accumulatedPcm: [],
      lastAcousticFeatures: {
        rms: 0,
        peak: 0,
        zeroCrossingRate: 0,
        estimatedPitchHz: 120,
        vocalStrain: "normal",
      },
      interrupted: false,
    };
    this.sessions.set(socket, session);

    // Send initial session handshake
    this.sendJson(socket, {
      type: "session_ready",
      sampleRate: 16000,
      channels: 1,
      format: "pcm_s16le",
      protocolVersion: "2.0",
      bargeInEnabled: true,
      timestamp: Date.now(),
    });

    socket.on("message", async (data: any, isBinary: boolean) => {
      try {
        if (isBinary || Buffer.isBuffer(data)) {
          this.handleAudioBuffer(session, Buffer.from(data));
        } else {
          const text = data.toString();
          const json = JSON.parse(text);
          await this.handleControlMessage(session, json);
        }
      } catch (err: any) {
        console.warn("[VoiceStreamServer] Message processing error:", err.message);
      }
    });

    socket.on("close", () => {
      this.sessions.delete(socket);
    });
  }

  private handleAudioBuffer(session: VoiceClientSession, buffer: Buffer) {
    session.accumulatedPcm.push(buffer);
    if (session.accumulatedPcm.length > 50) {
      session.accumulatedPcm.shift(); // keep sliding window of recent speech
    }

    // Compute live acoustic prosody for orb visualization and stress detection
    const acoustic = sentimentAnalyzer.analyzeAcousticBuffer(buffer);
    session.lastAcousticFeatures = acoustic;

    // Send live audio energy metrics to client for visualizer animation
    this.sendJson(session.socket, {
      type: "audio_energy",
      rms: acoustic.rms,
      peak: acoustic.peak,
      pitchHz: acoustic.estimatedPitchHz,
      vocalStrain: acoustic.vocalStrain,
    });
  }

  private async handleControlMessage(session: VoiceClientSession, msg: any) {
    switch (msg.type) {
      case "barge_in": {
        session.interrupted = true;
        streamingTts.abort();
        eventBus.emitEvent("voice:state", { state: "listening", interrupted: true });
        this.sendJson(session.socket, {
          type: "barge_in_acknowledged",
          status: "speech_interrupted",
          timestamp: Date.now(),
        });
        break;
      }

      case "transcript_partial": {
        const text = msg.text || "";
        session.interrupted = false;
        // Compute partial sentiment
        const sentiment = sentimentAnalyzer.analyze(text, session.lastAcousticFeatures);
        this.sendJson(session.socket, {
          type: "transcript_partial",
          text,
          sentiment,
        });
        break;
      }

      case "transcript_final": {
        const command = msg.text || "";
        if (!command.trim()) return;

        session.interrupted = false;
        const sentiment = sentimentAnalyzer.analyze(command, session.lastAcousticFeatures);

        // Notify client of recognized command and full sentiment breakdown
        this.sendJson(session.socket, {
          type: "transcript_final",
          text: command,
          sentiment,
        });

        // Set state to thinking
        this.sendJson(session.socket, {
          type: "agent_state",
          state: "thinking",
          command,
          sentiment,
        });

        eventBus.emitEvent("audit:log", {
          id: `audit-${Date.now()}`,
          timestamp: Date.now(),
          source: "voice",
          agent: "voice_agent",
          action: "voice_turn.received",
          command,
          risk: "low",
          permission: "allowed",
          status: "info",
          details: { command, sentiment },
        });

        // Execute via Orchestrator
        try {
          const result = await orchestrator.executeCommand({
            command,
            source: "voice",
          });

          if (session.interrupted) {
            console.log("[VoiceStreamServer] Execution completed but client interrupted turn.");
            return;
          }

          // Send response back
          this.sendJson(session.socket, {
            type: "agent_state",
            state: "speaking",
            spokenSummary: result.spokenSummary,
            status: result.status,
            plan: result.plan,
            pendingTasks: result.pendingTasks,
            sentiment,
          });

          // Stream sentence/clause chunks for low-latency TTS synthesis (<500ms TTFA)
          if (result.spokenSummary && !session.interrupted) {
            await streamingTts.streamSpeech(result.spokenSummary, sentiment, (chunk) => {
              if (!session.interrupted) {
                this.sendJson(session.socket, {
                  type: "tts_chunk",
                  ...chunk,
                  sentiment,
                });
              }
            });
          }
        } catch (err: any) {
          this.sendJson(session.socket, {
            type: "agent_state",
            state: "error",
            error: err.message,
            spokenSummary: "I encountered an error processing your voice command.",
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private sendJson(socket: WebSocket, payload: any) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}

export const voiceStreamServer = new VoiceStreamServer();
