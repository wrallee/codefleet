export class CacheRepository {
  readonly endpoint = "redis://localhost:6379";

  getEndpoint() {
    return this.endpoint;
  }
}
