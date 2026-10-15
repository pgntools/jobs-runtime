/**
 * Web Locks in memory: one exclusive holder per name, the rest queued in request order. Share one
 * instance between runtimes to model tabs of one origin.
 */
export function memoryLock() {
    const holders = new Map();
    const queues = new Map();
    const grant = (name) => {
        const next = queues.get(name)?.shift();
        if (next)
            next();
    };
    return {
        acquire(name) {
            return new Promise((resolve) => {
                const take = () => {
                    const token = {};
                    holders.set(name, token);
                    resolve(() => {
                        if (holders.get(name) !== token)
                            return;
                        holders.delete(name);
                        grant(name);
                    });
                };
                if (!holders.has(name))
                    take();
                else
                    queues.set(name, [...(queues.get(name) ?? []), take]);
            });
        },
    };
}
//# sourceMappingURL=memoryLock.js.map