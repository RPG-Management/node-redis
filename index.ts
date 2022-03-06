import {
  createClient as _createClient,
  createCluster as _createCluster,
  RedisClientOptions,
  RedisClientType as _RedisClientType,
  RedisClusterOptions,
  RedisClusterType as _RedisClusterType,
  RedisModules,
  RedisScripts,
} from "@rpg-management/node-redis-client";

export * from "@rpg-management/node-redis-client";

const modules = {};

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
      ...(options?.modules as M),
    },
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
      ...(options?.modules as M),
    },
  });
}
