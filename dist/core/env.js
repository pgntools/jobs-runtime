export function readEnvelope(message, env) {
    if (typeof message !== "object" || message === null)
        return undefined;
    const m = message;
    if (m.ns !== env.namespace || m.from === env.owner)
        return undefined;
    if (m.type === "changed")
        return { type: "changed" };
    if (typeof m.jobId !== "string")
        return undefined;
    if (m.type === "live")
        return { type: "live", jobId: m.jobId, payload: m.payload };
    if (m.type === "live-clear")
        return { type: "live-clear", jobId: m.jobId };
    return undefined;
}
//# sourceMappingURL=env.js.map