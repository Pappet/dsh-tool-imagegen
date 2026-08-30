/**
 * API-key resolution across the credentials seam and the process environment,
 * mirroring the `llm-pi-ai` / `dsh-github` convention: the reference name
 * (e.g. `OPENROUTER_API_KEY`) addresses a dsh credential first; the
 * same-named environment variable is the fallback. The value never reaches
 * model-visible text, session events, or logs.
 * @module dsh-tool-imagegen/key
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials';

/** Minimal structural view of the credentials seam (ctx.credentials). */
export interface CredentialsSeam {
    resolve(ref: unknown): Promise<{ value: string } | undefined>;
}

/** Resolve the API key: credentials seam → same-named environment variable. */
export async function resolveApiKey(
    credentials: CredentialsSeam | undefined,
    refName: string,
): Promise<string | undefined> {
    if (credentials) {
        try {
            const resolved = await credentials.resolve(credentialRef(refName));
            if (resolved?.value) return resolved.value;
        } catch {
            // Invalid reference name or seam failure → fall through to env.
        }
    }
    const value = process.env[refName];
    return value && value.length > 0 ? value : undefined;
}
