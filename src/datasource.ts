import _ from 'lodash';

import {
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  getDefaultRelativeTimeRange,
  LoadingState,
  MetricFindValue,
} from '@grafana/data';

import { getBackendSrv, toDataQueryResponse, getTemplateSrv, } from '@grafana/runtime';

import { MyQuery, MyDataSourceOptions } from './types';
import retryOrThrow from 'util/retry';
import { SELECT_PLACEHOLDERS, AUTO, regionsQueryRegex, compartmentsQueryRegex, namespacesQueryRegex, resourcegroupsQueryRegex, metricsQueryRegex, dimensionKeysQueryRegex, dimensionValuesQueryRegex } from './constants';
import { resolveAutoWinRes, removeQuotes } from 'util/utilFunctions';

const DEFAULT_RESOURCE_GROUP = 'NoResourceGroup';
export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  constructor(private instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>) {
    super(instanceSettings);
  }

  region = this.instanceSettings.jsonData.region;
  tenancyOCID = this.instanceSettings.jsonData.tenancy;
  environment = this.instanceSettings.jsonData.environment;
  resolution = this.instanceSettings.jsonData.resolution;
  defaultRegion = this.instanceSettings.jsonData.defaultRegion;
  compartmentsCache = [];
  regionsCache = [];
  templateSrv= getTemplateSrv()

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    var query = await this.buildQueryParameters(options);
    if (query.targets.length <= 0) {
      return Promise.resolve({ data: [] });
    }

    return this.doRequest(query).then((result) => {
      var res: any[] = [];
      _.forEach(result.data, (r) => {
        _.forEach(r.series, (s) => {
          res.push({ target: s.name, datapoints: s.points });
        });
        _.forEach(r.tables, (t) => {
          t.type = "table";
          t.refId = r.refId;
          res.push(t);
        });
      });

      result.data = res;
      return result;
    });
  }

  async testDatasource() {
    // Implement a health check for your data source.
    return this.doRequest({
      targets: [
        {
          queryType: 'test',
          region: this.region,
          tenancyOCID: this.tenancyOCID,
          environment: this.environment,
          datasourceId: this.id,
        },
      ],
      range: getDefaultRelativeTimeRange(),
    })
      .then((response) => {
        if (response.state === LoadingState.Done) {
          return {
            status: 'success',
            message: 'Data source is working',
            title: 'Success',
          };
        } else {
          throw Error('error');
        }
      })
      .catch(() => {
        return {
          status: 'error',
          message: 'Data source is not working',
          title: 'Failure',
        };
      });
  }

   /**
   * Required method
   * Used by query editor to get metric suggestions
   */
    async metricFindQuery(target:any): Promise<MetricFindValue[]> {
      if (typeof target === "string") {
        // used in template editor for creating variables
        return this.templateMetricQuery(target);
      }
      const region =
        target.region === SELECT_PLACEHOLDERS.REGION
          ? ""
          : this.getVariableValue(target.region);
      const compartment =
        target.compartment === SELECT_PLACEHOLDERS.COMPARTMENT
          ? ""
          : this.getVariableValue(target.compartment);
      const namespace =
        target.namespace === SELECT_PLACEHOLDERS.NAMESPACE
          ? ""
          : this.getVariableValue(target.namespace);
      const resourcegroup =
        target.resourcegroup === SELECT_PLACEHOLDERS.RESOURCEGROUP
          ? DEFAULT_RESOURCE_GROUP
          : this.getVariableValue(target.resourcegroup);
  
      if (_.isEmpty(compartment) || _.isEmpty(namespace)) {
        return Promise.resolve([]);
      }
  
      const compartmentId = await this.getCompartmentId(compartment);
      return this.doRequest({
        targets: [
          {
            environment: this.environment,
            datasourceId: this.id,
            tenancyOCID: this.tenancyOCID,
            queryType: "search",
            region: _.isEmpty(region) ? this.defaultRegion : region,
            compartment: compartmentId,
            namespace: namespace,
            resourcegroup: resourcegroup,
          },
        ]
      }).then((res) => {
        return this.mapToTextValue(res, "search");
      });
    }
    
  async doRequest(options: any) {
    return retryOrThrow(async () => {
      return await getBackendSrv().datasourceRequest({
        url: '/api/ds/query',
        method: 'POST',
        data: {
          from: options.range.from.valueOf().toString(),
          to: options.range.to.valueOf().toString(),
          queries: options.targets,
        },
      });
    }, 1).then((res: any) => toDataQueryResponse(res, options));
  }

  getVariableValue(varName: any, scopedVars = {}) {
    return getTemplateSrv().replace(varName, scopedVars) || varName;
  }
  
  /**
   * Build and validate query parameters.
   */
  async buildQueryParameters(options:DataQueryRequest<MyQuery>) {
    const {targets, range} = options
    let queries = targets
      .filter((t) => !t.hide)
      .filter(
        (t) =>
          !_.isEmpty(
            this.getVariableValue(t.compartment, options.scopedVars)
          ) && t.compartment !== SELECT_PLACEHOLDERS.COMPARTMENT
      )
      .filter(
        (t) =>
          !_.isEmpty(this.getVariableValue(t.namespace, options.scopedVars)) &&
          t.namespace !== SELECT_PLACEHOLDERS.NAMESPACE
      )
      .filter(
        (t) =>
          !_.isEmpty(this.getVariableValue(t.resourcegroup, options.scopedVars))
      )
      .filter(
        (t) =>
          (!_.isEmpty(this.getVariableValue(t.metric, options.scopedVars)) &&
            t.metric !== SELECT_PLACEHOLDERS.METRIC) ||
          !_.isEmpty(this.getVariableValue(t.target))
      );

    queries.forEach((t) => {
      t.dimensions = (t.dimensions || [])
        .filter(
          (dim) =>
            !_.isEmpty(dim.key) && dim.key !== SELECT_PLACEHOLDERS.DIMENSION_KEY
        )
        .filter(
          (dim) =>
            !_.isEmpty(dim.value) &&
            dim.value !== SELECT_PLACEHOLDERS.DIMENSION_VALUE
        );

      t.resourcegroup =
        t.resourcegroup === SELECT_PLACEHOLDERS.RESOURCEGROUP
          ? DEFAULT_RESOURCE_GROUP
          : t.resourcegroup;
    });

    // we support multiselect for dimension values, so we need to parse 1 query into multiple queries
    queries = this.splitMultiValueDimensionsIntoQuieries(queries, options);

    const results = [];
    for (let t of queries) {
      const region =
        t.region === SELECT_PLACEHOLDERS.REGION
          ? ""
          : this.getVariableValue(t.region, options.scopedVars);
      let query = this.getVariableValue(t.target, options.scopedVars);
      const numberOfDaysDiff = range.to.diff(range.from,'days')
      // The following replaces 'auto' in window portion of the query and replaces it with an appropriate value.
      // If there is a functionality to access the window variable instead of matching [auto] in the query, it will be
      // better
      if (query)
        query = query.replace(
          "[auto]",
          `[${resolveAutoWinRes(AUTO, "", numberOfDaysDiff).window}]`
        );
      let resolution = this.getVariableValue(t.resolution, options.scopedVars);
      let window =
        t.window === SELECT_PLACEHOLDERS.WINDOW
          ? ""
          : this.getVariableValue(t.window, options.scopedVars);
      // p.s : timeSrv.timeRange() results in a moment object
      const resolvedWinResolObj = resolveAutoWinRes(
        window,
        resolution,
        numberOfDaysDiff
      );
      window = resolvedWinResolObj.window;
      resolution = resolvedWinResolObj.resolution;
      if (_.isEmpty(query)) {
        // construct query
        const dimensions = (t.dimensions || []).reduce((result, dim) => {
          const d = `${this.getVariableValue(dim.key, options.scopedVars)} ${
            dim.operator
          } "${this.getVariableValue(dim.value, options.scopedVars)}"`;
          if (result.indexOf(d) < 0) {
            result.push(d);
          }
          return result;
        }, []);
        const dimension = _.isEmpty(dimensions)
          ? ""
          : `{${dimensions.join(",")}}`;
        query = `${this.getVariableValue(
          t.metric,
          options.scopedVars
        )}[${window}]${dimension}.${t.aggregation}`;
      }

      const compartmentId = await this.getCompartmentId(
        this.getVariableValue(t.compartment, options.scopedVars)
      );
      const result = {
        resolution,
        environment: this.environment,
        datasourceId: this.id,
        tenancyOCID: this.tenancyOCID,
        queryType: "query",
        refId: t.refId,
        hide: t.hide,
        type: t.type || "timeserie",
        region: _.isEmpty(region) ? this.defaultRegion : region,
        compartment: compartmentId,
        namespace: this.getVariableValue(t.namespace, options.scopedVars),
        resourcegroup: this.getVariableValue(
          t.resourcegroup,
          options.scopedVars
        ),
        query: query,
      };
      results.push(result);
    }

    options.targets = results as any;

    return options;
  }

  splitMultiValueDimensionsIntoQuieries(queries: any, options: any) {
    return queries.reduce((data: any, t: any) => {
      if (_.isEmpty(t.dimensions) || !_.isEmpty(t.target)) {
        // nothing to split or dimensions won't be used, query is set manually
        return data.concat(t);
      }

      // create a map key : [values] for multiple values
      const multipleValueDims = t.dimensions.reduce((data: any, dim: any) => {
        const key = dim.key;
        const value = this.getVariableValue(dim.value, options.scopedVars);
        if (value.startsWith('{') && value.endsWith('}')) {
          const values = value.slice(1, value.length - 1).split(',') || [];
          data[key] = (data[key] || []).concat(values);
        }
        return data;
      }, {});

      if (_.isEmpty(Object.keys(multipleValueDims))) {
        // no multiple values used, only single values
        return data.concat(t);
      }

      const splitDimensions = (dims: any, multiDims: any) => {
        let prev = [];
        let next: any[] = [];

        const firstDimKey = dims[0].key;
        const firstDimValues = multiDims[firstDimKey] || [dims[0].value];
        for (let v of firstDimValues) {
          const newDim = _.cloneDeep(dims[0]);
          newDim.value = v;
          prev.push([newDim]);
        }

        for (let i = 1; i < dims.length; i++) {
          const values = multiDims[dims[i].key] || [dims[i].value];
          for (let v of values) {
            for (let j = 0; j < prev.length; j++) {
              if (next.length >= 20) {
                // this algorithm of collecting multi valued dimensions is computantionally VERY expensive
                // set the upper limit for quiries number
                return next;
              }
              const newDim = _.cloneDeep(dims[i]);
              newDim.value = v;
              next.push(prev[j].concat(newDim));
            }
          }
          prev = next;
          next = [];
        }

        return prev;
      };

      const newDimsArray = splitDimensions(t.dimensions, multipleValueDims);

      const newQueries = [];
      for (let i = 0; i < newDimsArray.length; i++) {
        const dims = newDimsArray[i];
        const newQuery = _.cloneDeep(t);
        newQuery.dimensions = dims;
        if (i !== 0) {
          newQuery.refId = `${newQuery.refId}${i}`;
        }
        newQueries.push(newQuery);
      }
      return data.concat(newQueries);
    }, []);
  }


// **************************** Template variable helpers ****************************

  /**
   * Matches the regex from creating template variables and returns options for the corresponding variable.
   * Example:
   * template variable with the query "regions()" will be matched with the regionsQueryRegex and list of available regions will be returned.
   */
   templateMetricQuery(varString:string) {
    let regionQuery = varString.match(regionsQueryRegex);
    if (regionQuery) {
      return this.getRegions().catch((err) => {
        throw new Error("Unable to get regions: " + err);
      });
    }

    let compartmentQuery = varString.match(compartmentsQueryRegex);
    if (compartmentQuery) {
      return this.getCompartments()
        .then((compartments) => {
          return compartments.map((c:any) => ({ text: c.text, value: c.text }));
        })
        .catch((err) => {
          throw new Error("Unable to get compartments: " + err);
        });
    }

    let namespaceQuery = varString.match(namespacesQueryRegex);
    if (namespaceQuery) {
      let target = {
        region: removeQuotes(this.getVariableValue(namespaceQuery[1])),
        compartment: removeQuotes(this.getVariableValue(namespaceQuery[2])),
      };
      return this.getNamespaces(target).catch((err) => {
        throw new Error("Unable to get namespaces: " + err);
      });
    }

    let resourcegroupQuery = varString.match(resourcegroupsQueryRegex);
    if (resourcegroupQuery) {
      let target = {
        region: removeQuotes(this.getVariableValue(resourcegroupQuery[1])),
        compartment: removeQuotes(this.getVariableValue(resourcegroupQuery[2])),
        namespace: removeQuotes(this.getVariableValue(resourcegroupQuery[3])),
      };
      return this.getResourceGroups(target).catch((err) => {
        throw new Error("Unable to get resourcegroups: " + err);
      });
    }

    let metricQuery = varString.match(metricsQueryRegex);
    if (metricQuery) {
      let target = {
        region: removeQuotes(this.getVariableValue(metricQuery[1])),
        compartment: removeQuotes(this.getVariableValue(metricQuery[2])),
        namespace: removeQuotes(this.getVariableValue(metricQuery[3])),
        resourcegroup: removeQuotes(this.getVariableValue(metricQuery[4])),
      };
      return this.metricFindQuery(target).catch((err) => {
        throw new Error("Unable to get metrics: " + err);
      });
    }

    let dimensionsQuery = varString.match(dimensionKeysQueryRegex);
    if (dimensionsQuery) {
      let target = {
        region: removeQuotes(this.getVariableValue(dimensionsQuery[1])),
        compartment: removeQuotes(this.getVariableValue(dimensionsQuery[2])),
        namespace: removeQuotes(this.getVariableValue(dimensionsQuery[3])),
        metric: removeQuotes(this.getVariableValue(dimensionsQuery[4])),
        resourcegroup: removeQuotes(this.getVariableValue(dimensionsQuery[5])),
      };
      return this.getDimensionKeys(target).catch((err) => {
        throw new Error("Unable to get dimensions: " + err);
      });
    }

    let dimensionOptionsQuery = varString.match(dimensionValuesQueryRegex);
    if (dimensionOptionsQuery) {
      let target = {
        region: removeQuotes(this.getVariableValue(dimensionOptionsQuery[1])),
        compartment: removeQuotes(
          this.getVariableValue(dimensionOptionsQuery[2])
        ),
        namespace: removeQuotes(
          this.getVariableValue(dimensionOptionsQuery[3])
        ),
        metric: removeQuotes(this.getVariableValue(dimensionOptionsQuery[4])),
        resourcegroup: removeQuotes(
          this.getVariableValue(dimensionOptionsQuery[6])
        ),
      };
      const dimensionKey = removeQuotes(
        this.getVariableValue(dimensionOptionsQuery[5])
      );
      return this.getDimensionValues(target, dimensionKey).catch((err) => {
        throw new Error("Unable to get dimension options: " + err);
      });
    }

    throw new Error("Unable to parse templating string");
  }

  getCompartmentId(compartment:string) {
    return this.getCompartments().then((compartments:any) => {
      const compartmentFound = compartments.find(
        (c:any) => c.text === compartment || c.value === compartment
      );
      return compartmentFound ? compartmentFound.value : compartment;
    });
  }

  getRegions() {
    if (this.regionsCache && this.regionsCache.length > 0) {
      return Promise.resolve(this.regionsCache);
    }

    return this.doRequest({
      targets: [
        {
          environment: this.environment,
          datasourceId: this.id,
          tenancyOCID: this.tenancyOCID,
          queryType: "regions",
        },
      ]
    }).then((items) => {
      this.regionsCache = this.mapToTextValue(items, "regions");
      return this.regionsCache;
    });
  }

  getCompartments() {
    if (this.compartmentsCache && this.compartmentsCache.length > 0) {
      return Promise.resolve(this.compartmentsCache)
    }

    return this.doRequest({
      targets: [
        {
          environment: this.environment,
          datasourceId: this.id,
          tenancyOCID: this.tenancyOCID,
          queryType: "compartments",
          region: this.defaultRegion, // compartments are registered for the all regions, so no difference which region to use here
        },
      ],
    }).then((items) => {
      this.compartmentsCache = this.mapToTextValue(items, "compartments");
      return this.compartmentsCache;
    });
  }

  async getNamespaces(target:any) {
    const region =
      target.region === SELECT_PLACEHOLDERS.REGION
        ? ""
        : this.getVariableValue(target.region);
    const compartment =
      target.compartment === SELECT_PLACEHOLDERS.COMPARTMENT
        ? ""
        : this.getVariableValue(target.compartment);
    if (_.isEmpty(compartment)) {
      return Promise.resolve([]);
    }

    const compartmentId = await this.getCompartmentId(compartment);
    return this.doRequest({
      targets: [
        {
          environment: this.environment,
          datasourceId: this.id,
          tenancyOCID: this.tenancyOCID,
          queryType: "namespaces",
          region: _.isEmpty(region) ? this.defaultRegion : region,
          compartment: compartmentId,
        },
      ]
    }).then((items) => {
      return this.mapToTextValue(items, "namespaces");
    });
  }

  async getResourceGroups(target:any) {
    const region =
      target.region === SELECT_PLACEHOLDERS.REGION
        ? ""
        : this.getVariableValue(target.region);
    const compartment =
      target.compartment === SELECT_PLACEHOLDERS.COMPARTMENT
        ? ""
        : this.getVariableValue(target.compartment);
    const namespace =
      target.namespace === SELECT_PLACEHOLDERS.NAMESPACE
        ? ""
        : this.getVariableValue(target.namespace);
    if (_.isEmpty(compartment)) {
      return Promise.resolve([]);
    }

    const compartmentId = await this.getCompartmentId(compartment);
    return this.doRequest({
      targets: [
        {
          environment: this.environment,
          datasourceId: this.id,
          tenancyOCID: this.tenancyOCID,
          queryType: "resourcegroups",
          region: _.isEmpty(region) ? this.defaultRegion : region,
          compartment: compartmentId,
          namespace: namespace,
        },
      ],
    }).then((items) => {
      return this.mapToTextValue(items, "resourcegroups");
    });
  }

  async getDimensions(target:any) {
    const region =
      target.region === SELECT_PLACEHOLDERS.REGION
        ? ""
        : this.getVariableValue(target.region);
    const compartment =
      target.compartment === SELECT_PLACEHOLDERS.COMPARTMENT
        ? ""
        : this.getVariableValue(target.compartment);
    const namespace =
      target.namespace === SELECT_PLACEHOLDERS.NAMESPACE
        ? ""
        : this.getVariableValue(target.namespace);
    const resourcegroup =
      target.resourcegroup === SELECT_PLACEHOLDERS.RESOURCEGROUP
        ? DEFAULT_RESOURCE_GROUP
        : this.getVariableValue(target.resourcegroup);
    const metric =
      target.metric === SELECT_PLACEHOLDERS.METRIC
        ? ""
        : this.getVariableValue(target.metric);
    const metrics =
      metric.startsWith("{") && metric.endsWith("}")
        ? metric.slice(1, metric.length - 1).split(",")
        : [metric];

    if (_.isEmpty(compartment) || _.isEmpty(namespace) || _.isEmpty(metrics)) {
      return Promise.resolve([]);
    }

    const dimensionsMap = {} as any;
    for (let m of metrics) {
      if (dimensionsMap[m] !== undefined) {
        continue;
      }
      dimensionsMap[m] = null;

      const compartmentId = await this.getCompartmentId(compartment);
      await this.doRequest({
        targets: [
          {
            environment: this.environment,
            datasourceId: this.id,
            tenancyOCID: this.tenancyOCID,
            queryType: "dimensions",
            region: _.isEmpty(region) ? this.defaultRegion : region,
            compartment: compartmentId,
            namespace: namespace,
            resourcegroup: resourcegroup,
            metric: m,
          },
        ]
      })
        .then((result) => {
          const items = this.mapToTextValue(result, "dimensions");
          dimensionsMap[m] = [].concat(items);
        })
        .finally(() => {
          if (!dimensionsMap[m]) {
            dimensionsMap[m] = [];
          }
        });
    }

    let result:any = [];
    Object.values(dimensionsMap).forEach((dims:any) => {
      if (_.isEmpty(result)) {
        result = dims;
      } else {
        const newResult:any = [];
        dims.forEach((dim:any) => {
          if (
            !!result.find((d:any) => d.value === dim.value) &&
            !newResult.find((d:any) => d.value === dim.value)
          ) {
            newResult.push(dim);
          }
        });
        result = newResult;
      }
    });

    return result;
  }

  getDimensionKeys(target:any) {
    return this.getDimensions(target)
      .then((dims) => {
        const dimCache = dims.reduce((data:any, item:any) => {
          const values = item.value.split("=") || [];
          const key = values[0] || item.value;
          const value = values[1];

          if (!data[key]) {
            data[key] = [];
          }
          data[key].push(value);
          return data;
        }, {});
        return Object.keys(dimCache);
      })
      .then((items) => {
        return items.map((item) => ({ text: item, value: item }));
      });
  }

  getDimensionValues(target:any, dimKey:any) {
    return this.getDimensions(target)
      .then((dims) => {
        const dimCache = dims.reduce((data:any, item:any) => {
          const values = item.value.split("=") || [];
          const key = values[0] || item.value;
          const value = values[1];

          if (!data[key]) {
            data[key] = [];
          }
          data[key].push(value);
          return data;
        }, {});
        return dimCache[this.getVariableValue(dimKey)] || [];
      })
      .then((items) => {
        return items.map((item:any) => ({ text: item, value: item }));
      });
  }

  /**
   * Converts data from grafana backend to UI format
   */
   mapToTextValue(result:any, searchField:any) {
    if (_.isEmpty(result)) return [];

    // All drop-downs send a request to the backend and based on the query type, the backend sends a response
    // Depending on the data available , options are shaped
    // Values in fields are of type vectors (Based on the info from Grafana)

    switch (searchField) {
      case "compartments":
        return result.data[0].fields[0].values.toArray().map((name:string, i:number) => ({
          text: name,
          value: result.data[0].fields[1].values.toArray()[i],
        }));
      case "regions":
      case "namespaces":
      case "resourcegroups":
      case "search":
      case "dimensions":
        return result.data[0].fields[0].values.toArray().map((name:string) => ({
          text: name,
          value: name,
        }));
      // remaining  cases will be completed once the fix works for the above two
      default:
        return {};
    }
  }

    /**
   * List all variable names optionally filtered by regex or/and type
   * Returns list of names with '$' at the beginning. Example: ['$dimensionKey', '$dimensionValue']
   *
   * Updates:
   * Notes on implementation :
   * If a custom or constant is in  variables and  includeCustom, default is false.
   * Hence,the varDescriptors list is filtered for a unique set of var names
   */
     getVariables(regex:string, includeCustom:boolean) {
      const varDescriptors =
        this.getVariableDescriptors(regex, includeCustom) || [];
      return varDescriptors.map((item:any) => `$${item.name}`);
    }

    getVariableDescriptors(regex:string, includeCustom = true) {
      const vars = this.templateSrv.getVariables() || [];
  
      if (regex) {
        let regexVars = vars.filter((item:any) => _.isString(item.query) && item.query.match(regex) !== null);
        if (includeCustom) {
          const custom = vars.filter(
            (item) => item.type === "custom" || item.type === "constant"
          );
          regexVars = regexVars.concat(custom);
        }
        const uniqueRegexVarsMap = new Map();
        regexVars.forEach((varObj) =>
          uniqueRegexVarsMap.set(varObj.name, varObj)
        );
        return Array.from(uniqueRegexVarsMap.values());
      }
      return vars;
    }

  /**
   * @param varName valid varName contains '$'. Example: '$dimensionKey'
   * Returns true if variable with the given name is found
   */
  isVariable(varName:any) {
    const varNames = this.templateSrv.getVariables() || [];
    return !!varNames.find((item) => item === varName);
  }
}

