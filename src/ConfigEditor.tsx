import React, { ChangeEvent, FunctionComponent } from 'react';
import { InlineField, LegacyForms } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps, SelectableValue } from '@grafana/data';
import { MyDataSourceOptions } from './types';
import { regions, environments } from './constants';

const { FormField, Select } = LegacyForms;

interface Props extends DataSourcePluginOptionsEditorProps<MyDataSourceOptions> {}

const regionOptions: SelectableValue[] = regions.map((reg) => ({ value: reg, label: reg }));
const envOptions: SelectableValue[] = environments.map((env) => ({ value: env, label: env }));
const strToSelectValue = (str: string): SelectableValue => ({ value: str, label: str });

export const ConfigEditor: FunctionComponent<Props> = ({ onOptionsChange, options }) => {
  const { jsonData } = options;
  const onTenancyChange = (event: ChangeEvent<HTMLInputElement>) => {
    const jsonData = {
      ...options.jsonData,
      tenancy: event.target.value,
    };
    onOptionsChange({ ...options, jsonData });
  };

  const onRegionChange = (value: SelectableValue) => {
    const jsonData = {
      ...options.jsonData,
      region: value.value,
    };
    onOptionsChange({ ...options, jsonData });
  };

  const onEnvChange = (value: SelectableValue) => {
    const jsonData = {
      ...options.jsonData,
      environment: value.value,
    };
    onOptionsChange({ ...options, jsonData });
  };

  const onResolutionChange = (event: ChangeEvent<HTMLInputElement>) => {
    const jsonData = {
      ...options.jsonData,
      resolution: parseFloat(event.target.value),
    };
    onOptionsChange({ ...options, jsonData });
  };

  return (
    <div className="gf-form-group">
      <h3 className="page-heading">OCI settings</h3>
      <div className="gf-form">
        <FormField
          label="Tenancy OCID"
          labelWidth={10}
          inputWidth={20}
          onChange={onTenancyChange}
          value={jsonData.tenancy || ''}
          placeholder="ocid1.tenancy.oc1..."
          required={true}
        />
      </div>
      <div className="gf-form">
        <InlineField label="Default Region" labelWidth={20}>
          <Select
            options={regionOptions}
            onChange={onRegionChange}
            width={20}
            value={strToSelectValue(jsonData.region)}
          />
        </InlineField>
      </div>
      <div className="gf-form">
        <InlineField label="Environment" labelWidth={20}>
          <Select
            options={envOptions}
            onChange={onEnvChange}
            width={20}
            value={strToSelectValue(jsonData.environment)}
          />
        </InlineField>
      </div>
      <div className="gf-form">
        <FormField
          label="Resolution"
          onChange={onResolutionChange}
          value={jsonData.resolution || ''}
          placeholder="Enter a number"
        />
      </div>
    </div>
  );
};
