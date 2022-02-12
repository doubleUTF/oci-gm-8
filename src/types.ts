import { DataQuery, DataSourceJsonData } from '@grafana/data';

export interface MyQuery extends DataQuery {
  queryText?: string;
  // constant: number;
  // frequency: number;
  compartment:string;
  region:string;
  namespace:string;
  resourcegroup:string;
  metric:string;
  resolution?:number;
  window?:string;
  target?:string;
  dimensions?:any[]
  aggregation?:string;
  type?:any;
}

export const defaultQuery: Partial<MyQuery> = {
  // constant: 6.5,
  // frequency: 1.0,
};

/**
 * These are options configured for each DataSource instance
 */
export interface MyDataSourceOptions extends DataSourceJsonData {
  path?: string;
  resolution?: number;
  region: string;
  tenancy: string;
  environment: string;
}

/**
 * Value that is used in the backend, but never sent over HTTP to the frontend
 */
export interface MySecureJsonData {
  apiKey?: string;
}
