import { logger } from '../../utils/logger.js';
import { createHttpClient, type HttpClient } from '../http-client.js';

export interface ExampleApiResponse {
  data: string[];
  total: number;
  page: number;
}

export interface ExampleApiOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class ExampleApiService {
  private client: HttpClient;
  private baseUrl: string;

  constructor(options: ExampleApiOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://api.example.com';

    // Create HTTP client with API-specific configuration
    this.client = createHttpClient({
      baseHeaders: {
        'Content-Type': 'application/json',
        'User-Agent': 'MCP-Server-Template/1.0.0',
        ...(options.apiKey && { Authorization: `Bearer ${options.apiKey}` }),
      },
      timeout: 15000,
      retries: 2,
      rateLimit: { rps: 5, burst: 10 }, // API-specific rate limits
    });
  }

  async search(query: string, limit = 10): Promise<ExampleApiResponse> {
    logger.debug('example_api_service', { message: 'Search request', query, limit });

    try {
      const url = new URL('/search', this.baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', limit.toString());

      const response = await this.client(url.toString());

      if (!response.ok) {
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as ExampleApiResponse;

      logger.info('example_api_service', {
        message: 'Search completed',
        query,
        resultCount: data.total,
      });

      return data;
    } catch (error) {
      logger.error('example_api_service', {
        message: 'Search failed',
        query,
        error: (error as Error).message,
      });
      throw new Error(`Search failed: ${(error as Error).message}`);
    }
  }

  async getItem(id: string): Promise<{ id: string; name: string; data: unknown }> {
    logger.debug('example_api_service', { message: 'Get item request', id });

    try {
      const response = await this.client(`${this.baseUrl}/items/${id}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Item not found: ${id}`);
        }
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const item = (await response.json()) as {
        id: string;
        name: string;
        data: unknown;
      };

      logger.info('example_api_service', {
        message: 'Item retrieved',
        id,
        name: item.name,
      });

      return item;
    } catch (error) {
      logger.error('example_api_service', {
        message: 'Get item failed',
        id,
        error: (error as Error).message,
      });
      throw new Error(`Get item failed: ${(error as Error).message}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client(`${this.baseUrl}/health`, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }
}
