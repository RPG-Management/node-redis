import {
    RedisModules,
    RedisScripts,
    createClient as _createClient,
    RedisClientOptions,
    RedisClientType as _RedisClientType,
    createCluster as _createCluster,
    RedisClusterOptions,
    RedisClusterType as _RedisClusterType
} from '@node-redis/client';
import RedisJSON from '@node-redis/json';

export * from '@node-redis/client';
export * from '@node-redis/json';

const modules = {
    json: RedisJSON,
};

export type RedisDefaultModules = typeof modules;

export type RedisClientType<
    M extends RedisModules = RedisDefaultModules,
    S extends RedisScripts = Record<string, never>
> = _RedisClientType<M, S>;

export function createClient<M extends RedisModules, S extends RedisScripts>(
    options?: RedisClientOptions<M, S>
): _RedisClientType<RedisDefaultModules & M, S> {
    return _createClient({
        ...options,
        modules: {
            ...modules,
            ...(options?.modules as M)
        }
    });
}

export type RedisClusterType<
    M extends RedisModules = RedisDefaultModules,
    S extends RedisScripts = Record<string, never>
> = _RedisClusterType<M, S>;

export function createCluster<M extends RedisModules, S extends RedisScripts>(
    options: RedisClusterOptions<M, S>
): RedisClusterType<RedisDefaultModules & M, S> {
    return _createCluster({
        ...options,
        modules: {
            ...modules,
            ...(options?.modules as M)
        }
    });
}
