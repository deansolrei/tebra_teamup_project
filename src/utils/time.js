export function toUtcIso(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date input: ${input}`);
    }
    return date.toISOString();
}

export function addMinutes(input, minutes) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date input: ${input}`);
    }
    return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
