import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config/env.ts";
import { toolsMetadata } from "../config/metadata.ts";
import { getUserBearer } from "../core/auth.ts";
import { createHttpClient } from "../services/http-client.ts";
import {
  type SpotifyControlInput,
  SpotifyControlInputSchema,
} from "../schemas/inputs.ts";
import { SpotifyControlBatchOutput } from "../schemas/outputs.ts";
import {
  next as apiNext,
  pause as apiPause,
  play as apiPlay,
  previous as apiPrevious,
  queueUri as apiQueue,
  repeat as apiRepeat,
  seek as apiSeek,
  shuffle as apiShuffle,
  transfer as apiTransfer,
  volume as apiVolume,
  getCurrentlyPlaying,
  getPlayerState,
  listDevices,
} from "../services/spotify/player.ts";
import type { ErrorCode } from "../utils/http-result.ts";
import { logger } from "../utils/logger.ts";
import { apiBase } from "../utils/spotify.ts";
import { validateDev } from "../utils/validate.ts";

const http = createHttpClient({
  baseHeaders: {
    "Content-Type": "application/json",
    "User-Agent": `mcp-spotify/${config.MCP_VERSION}`,
  },
  rateLimit: { rps: 5, burst: 10 },
  timeout: 20000,
  retries: 1,
});

export const spotifyControlTool = {
  name: "spotify_control",
  title: toolsMetadata.spotify_control.title,
  description: toolsMetadata.spotify_control.description,
  inputSchema: SpotifyControlInputSchema.shape,

  handler: async (
    args: SpotifyControlInput,
    signal?: AbortSignal
  ): Promise<CallToolResult> => {
    try {
      const parsed = SpotifyControlInputSchema.parse(args);
      const token = await getUserBearer();
      if (!token) {
        return toolError("Not signed in. Please authenticate.", "unauthorized");
      }
      const headers = { Authorization: `Bearer ${token}` };
      const baseUrl = apiBase(config.SPOTIFY_API_URL);

      const runOp = (
        operation: SpotifyControlInput["operations"][number],
        index: number
      ) => executeOperation({ operation, index, headers, baseUrl, signal });

      const results = parsed.parallel
        ? await Promise.all(parsed.operations.map(runOp))
        : await (async () => {
            const acc: Awaited<ReturnType<typeof executeOperation>>[] = [];
            for (let i = 0; i < parsed.operations.length; i++) {
              const op = parsed.operations[i];
              if (op) acc.push(await runOp(op, i));
            }
            return acc;
          })();

      const okActions = results.filter((r) => r.ok).map((r) => r.action);
      const failed = results.filter((r) => !r.ok);
      const failedCount = failed.length;
      const okCount = okActions.length;

      let summary =
        okCount > 0
          ? `Successful: ${okActions.join(", ")}.`
          : `No successful operations.`;
      if (failedCount > 0) {
        const failedActions = failed.map((r) => r.action);
        summary += ` Failed (${failedCount}): ${failedActions.join(", ")}.`;
      }

      try {
        const successfulPlayIndices = results
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => r.ok && r.action === "play")
          .map(({ i }) => i);
        const lastSuccessfulPlayIndex =
          successfulPlayIndices.length > 0
            ? successfulPlayIndices[successfulPlayIndices.length - 1]
            : undefined;
        const lastPlayOp =
          typeof lastSuccessfulPlayIndex === "number"
            ? parsed.operations[lastSuccessfulPlayIndex]
            : undefined;

        const [player, current] = await Promise.all([
          getPlayerState(http, baseUrl, headers, signal),
          getCurrentlyPlaying(http, baseUrl, headers, signal).catch(() => null),
        ]);
        let deviceName: string | undefined;
        let volumePercent: number | undefined;
        let currentTrackUri: string | undefined;
        let currentTrackName: string | undefined;
        let contextUri: string | undefined;
        let contextName: string | undefined;

        if (player?.device?.id) {
          try {
            const devices = await listDevices(http, baseUrl, headers, signal);
            const active = devices?.devices?.find(
              (d) => d?.id === player.device?.id
            );
            if (active) {
              deviceName = (active.name ?? undefined) as string | undefined;
              volumePercent = (active.volume_percent ?? undefined) as
                | number
                | undefined;
            }
          } catch {}
        }
        if (player?.context?.uri) {
          contextUri = String(player.context.uri);
          try {
            const m = /^spotify:(playlist|album|artist):(.+)$/.exec(contextUri);
            if (m) {
              const [, kind, id] = m;
              const endpoint =
                kind === "playlist"
                  ? `playlists/${id}`
                  : kind === "album"
                  ? `albums/${id}`
                  : `artists/${id}`;
              const resp = await http(new URL(endpoint, baseUrl).toString(), {
                headers,
                signal,
              });
              if (resp.ok) {
                const j = await resp.json();
                const nm = (
                  j && typeof j === "object"
                    ? (j as Record<string, unknown>).name
                    : undefined
                ) as string | undefined;
                if (nm) contextName = nm;
              }
            }
          } catch {}
        }
        if (current && typeof current === "object") {
          const item = (current as Record<string, unknown>).item as {
            uri?: string;
            name?: string;
          };
          if (item) {
            currentTrackUri = item.uri as string | undefined;
            currentTrackName = item.name as string | undefined;
          }
        }

        const didVolume = okActions.includes("volume");
        const didPlayLike = okActions.some((a) =>
          ["play", "pause", "next", "previous", "seek", "transfer"].includes(a)
        );

        const statusBits: string[] = [];
        if (typeof player?.is_playing === "boolean") {
          statusBits.push(
            player.is_playing
              ? `Now playing${deviceName ? ` on '${deviceName}'` : ""}.`
              : `Playback is paused${deviceName ? ` on '${deviceName}'` : ""}.`
          );
        }
        if (currentTrackName)
          statusBits.push(`Current track: '${currentTrackName}'.`);
        if (didVolume && typeof volumePercent === "number")
          statusBits.push(`Volume: ${volumePercent}%`);

        if (lastPlayOp) {
          const contextVerified = lastPlayOp.context_uri
            ? contextUri === lastPlayOp.context_uri
            : undefined;
          let trackVerified: boolean | undefined;
          if (Array.isArray(lastPlayOp.uris) && currentTrackUri) {
            trackVerified = lastPlayOp.uris.includes(currentTrackUri);
          } else if (lastPlayOp.offset?.uri && currentTrackUri) {
            trackVerified = lastPlayOp.offset.uri === currentTrackUri;
          }
          if (contextVerified === true) {
            statusBits.push(
              `Context verified: ${contextName ? `'${contextName}' — ` : ""}${
                contextUri ?? ""
              }`.trim()
            );
          } else if (contextVerified === false) {
            statusBits.push(
              `Context mismatch${
                contextUri
                  ? ` (current: ${
                      contextName ? `'${contextName}' — ` : ""
                    }${contextUri})`
                  : ""
              }.`
            );
          }
          if (trackVerified === true) {
            statusBits.push(
              `Track verified${currentTrackUri ? `: ${currentTrackUri}` : ""}.`
            );
          } else if (trackVerified === false) {
            statusBits.push(
              `Track mismatch${
                currentTrackUri ? ` (current: ${currentTrackUri})` : ""
              }.`
            );
          }
        }
        if (statusBits.length > 0) {
          summary += ` Status: ${statusBits.join(" ")}`;
        } else if (didPlayLike) {
          summary += ` Status: Unable to confirm playback immediately.`;
        }
      } catch {}

      const structured: SpotifyControlBatchOutput = {
        _msg: summary,
        results,
        summary: { ok: okCount, failed: failedCount },
      };
      const contentParts: Array<{ type: "text"; text: string }> = [
        { type: "text", text: summary },
      ];
      if (config.SPOTIFY_MCP_INCLUDE_JSON_IN_CONTENT) {
        contentParts.push({ type: "text", text: JSON.stringify(structured) });
      }
      return {
        isError: failedCount > 0,
        content: contentParts,
        structuredContent: validateDev(SpotifyControlBatchOutput, structured),
      };
    } catch (error) {
      logger.error("spotify_control", { error: (error as Error).message });
      return toolError(`Control request failed: ${(error as Error).message}`);
    }
  },
};

type OperationDeps = {
  operation: SpotifyControlInput["operations"][number];
  index: number;
  headers: { Authorization: string };
  baseUrl: string;
  signal?: AbortSignal;
};

async function executeOperation({
  operation,
  index,
  headers,
  baseUrl,
  signal,
}: OperationDeps): Promise<SpotifyControlBatchOutput["results"][number]> {
  try {
    switch (operation.action) {
      case "play": {
        if (
          operation.context_uri &&
          operation.uris &&
          operation.uris.length > 0
        ) {
          return {
            index,
            action: "play",
            ok: false,
            error:
              "Provide either 'context_uri' (optionally with 'offset') or 'uris', not both.",
          };
        }
        await apiPlay(
          http,
          baseUrl,
          headers,
          {
            device_id: operation.device_id,
            context_uri: operation.context_uri,
            uris: operation.uris,
            offset: operation.offset,
            position_ms: operation.position_ms,
          },
          signal
        );
        return { index, action: "play", ok: true };
      }
      case "pause": {
        await apiPause(
          http,
          baseUrl,
          headers,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "pause", ok: true };
      }
      case "next": {
        await apiNext(
          http,
          baseUrl,
          headers,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "next", ok: true };
      }
      case "previous": {
        await apiPrevious(
          http,
          baseUrl,
          headers,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "previous", ok: true };
      }
      case "seek": {
        if (typeof operation.position_ms !== "number") {
          return {
            index,
            action: "seek",
            ok: false,
            error: "position_ms is required for seek",
          };
        }
        await apiSeek(
          http,
          baseUrl,
          headers,
          operation.position_ms,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "seek", ok: true };
      }
      case "shuffle": {
        if (typeof operation.shuffle !== "boolean") {
          return {
            index,
            action: "shuffle",
            ok: false,
            error: "shuffle is required for shuffle",
          };
        }
        await apiShuffle(
          http,
          baseUrl,
          headers,
          operation.shuffle,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "shuffle", ok: true };
      }
      case "repeat": {
        if (!operation.repeat) {
          return {
            index,
            action: "repeat",
            ok: false,
            error: "repeat is required for repeat",
          };
        }
        await apiRepeat(
          http,
          baseUrl,
          headers,
          operation.repeat,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "repeat", ok: true };
      }
      case "volume": {
        if (typeof operation.volume_percent !== "number") {
          return {
            index,
            action: "volume",
            ok: false,
            error: "volume_percent is required for volume",
          };
        }
        await apiVolume(
          http,
          baseUrl,
          headers,
          operation.volume_percent,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "volume", ok: true };
      }
      case "transfer": {
        if (!operation.device_id) {
          return {
            index,
            action: "transfer",
            ok: false,
            error: "device_id is required for transfer",
          };
        }
        let fromDeviceId: string | undefined;
        let fromDeviceName: string | undefined;
        try {
          const devices = await listDevices(http, baseUrl, headers, signal);
          const active = devices?.devices?.find((d) => d?.is_active);
          if (active) {
            fromDeviceId = active.id ?? undefined;
            fromDeviceName = (active.name ?? undefined) as string | undefined;
          }
        } catch {}
        await apiTransfer(
          http,
          baseUrl,
          headers,
          operation.device_id,
          operation.transfer_play ?? false,
          signal
        );
        let toDeviceName: string | undefined;
        try {
          const devices = await listDevices(http, baseUrl, headers, signal);
          const target = devices?.devices?.find(
            (d) => d?.id === operation.device_id
          );
          if (target)
            toDeviceName = (target.name ?? undefined) as string | undefined;
        } catch {}
        return {
          index,
          action: "transfer",
          ok: true,
          device_id: operation.device_id,
          device_name: toDeviceName,
          from_device_id: fromDeviceId,
          from_device_name: fromDeviceName,
        };
      }
      case "queue": {
        if (!operation.queue_uri) {
          return {
            index,
            action: "queue",
            ok: false,
            error: "queue_uri is required for queue",
          };
        }
        await apiQueue(
          http,
          baseUrl,
          headers,
          operation.queue_uri,
          { device_id: operation.device_id },
          signal
        );
        return { index, action: "queue", ok: true };
      }
      default:
        return {
          index,
          action: String((operation as { action: unknown }).action),
          ok: false,
          error: "Unknown action",
        };
    }
  } catch (error) {
    const message = (error as Error).message;
    const codeMatch = message.match(
      /\[(unauthorized|forbidden|rate_limited|bad_response)\]$/
    );
    const code = (codeMatch?.[1] as ErrorCode | undefined) ?? undefined;
    const result = {
      index,
      action: operation.action,
      ok: false,
      error: message.replace(/\s*\[[^\]]+\]$/, ""),
      code,
    };
    if (/no\s+active\s+device/i.test(message)) {
      (result as { note?: string }).note =
        "No active device. Ask the user to open Spotify on any device and retry, or use transfer to a listed device.";
    }
    return result as SpotifyControlBatchOutput["results"][number];
  }
}

function toolError(message: string, code?: ErrorCode): CallToolResult {
  const failedResult: SpotifyControlBatchOutput["results"][number] = {
    index: 0,
    action: "global",
    ok: false,
    error: message,
    code,
  };
  const structured: SpotifyControlBatchOutput = {
    _msg: message,
    results: [failedResult],
    summary: { ok: 0, failed: 1 },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: validateDev(SpotifyControlBatchOutput, structured),
  };
}
