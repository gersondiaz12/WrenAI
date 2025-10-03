import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, gql } from '@apollo/client';
import { Form, Input, Button, Space, message, Alert, Checkbox, Modal, Select } from 'antd';

const GET_LLM = gql`
  query GetLLMConfig {
    getLLMConfig
  }
`;

const UPDATE_LLM = gql`
  mutation UpdateLLMConfig($data: JSON!) {
    updateLLMConfig(data: $data)
  }
`;

const TEST_LLM = gql`
  mutation TestLLMConnection($data: JSON!) {
    testLLMConnection(data: $data)
  }
`;

const SWITCH_LLM = gql`
  mutation SwitchLLMNow($data: JSON!) {
    switchLLMNow(data: $data)
  }
`;

export default function LLMConfigForm() {
  const { data, loading, error } = useQuery(GET_LLM);
  const [updateLLM] = useMutation(UPDATE_LLM);
  const [testLLM] = useMutation(TEST_LLM);
  const [switchLLM] = useMutation(SWITCH_LLM);
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);
  const [persistKey, setPersistKey] = useState(true);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && data.getLLMConfig) {
      // getLLMConfig may return an array of docs or a single doc`
      const doc = Array.isArray(data.getLLMConfig)
        ? data.getLLMConfig[0]
        : data.getLLMConfig;
      if (doc) {
        // populate model options from doc.models
        try {
          const parsedModels = Array.isArray(doc.models) ? doc.models : [];
          const opts = parsedModels.map((m: any) => (m && m.model ? m.model : String(m))).filter(Boolean);
          setModelOptions(opts);
        } catch (e) {
          setModelOptions([]);
        }
        form.setFieldsValue({
          provider: doc.provider || '',
          api_base: doc.api_base || '',
          api_key: '', // masked by server; user should re-enter if needed
          api_key_env: doc.api_key_env || '',
          models: JSON.stringify(doc.models || [], null, 2),
          active_model: doc.active_model || (doc.models && doc.models[0] && doc.models[0].model) || undefined,
        });
      }
    }
  }, [data]);

  if (loading) return <div>Loading LLM config...</div>;
  if (error) return <div>Error loading LLM config: {String(error.message)}</div>;

  const doSave = async () => {
    try {
      setSaving(true);
      const values = await form.validateFields();
      const payload: any = {
        type: 'llm',
        provider: values.provider,
        api_base: values.api_base,
        models: JSON.parse(values.models || '[]'),
        active_model: values.active_model || undefined,
        persistKey: persistKey,
      };
      // only include api_key in payload when user opted to persist it
      if (persistKey && values.api_key) payload.api_key = values.api_key;
      await updateLLM({ variables: { data: payload } });
      message.success('LLM config saved');
      setConfirmVisible(false);
      setTestResult(null);
    } catch (e: any) {
      message.error('Failed to save: ' + (e.message || String(e)));
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    // if persistKey is true ask for confirmation
    if (persistKey) {
      setConfirmVisible(true);
      return;
    }
    await doSave();
  };

  const onTestConnection = async () => {
    try {
      const values = await form.validateFields(['provider', 'api_base', 'api_key', 'models']);
      setTesting(true);
      const payload = {
        type: 'llm',
        provider: values.provider,
        api_base: values.api_base,
        api_key: values.api_key,
        models: JSON.parse(values.models || '[]'),
        persistKey: false, // never persist when merely testing
      };
      const res = await testLLM({ variables: { data: payload } });
      setTesting(false);
      const result = res?.data?.testLLMConnection || { ok: false, error: 'No response' };
      setTestResult(result);
      if (result.ok) {
        message.success('Connection OK');
      } else {
        message.error('Connection failed');
      }
    } catch (e: any) {
      setTesting(false);
      setTestResult({ ok: false, error: e.message || String(e) });
      message.error('Test failed: ' + (e.message || String(e)));
    }
  };

  const onActiveModelChange = async (val: string) => {
    // live-switch active model without persisting keys
    try {
      setSaving(true);
      const payload: any = { type: 'llm', active_model: val };
      // call switchLLMNow to trigger runtime reinit
      const res = await switchLLM({ variables: { data: payload } });
      const ok = res?.data?.switchLLMNow?.ok;
      if (ok) {
        message.success('Active model switched (runtime)');
      } else {
        message.warning('Active model updated in config but runtime switch may not have completed');
      }
    } catch (e: any) {
      message.error('Failed to switch active model: ' + (e.message || String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <h2>LLM Configuration</h2>
      <Alert
        message="Note: API keys entered here will be saved to your local file ~/.wrenai/.env and the config will reference the env var name. Do not paste production secrets if you expect to use a different secret manager in production."
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />
  <Form form={form} layout="vertical">
        <Form.Item name="provider" label="Provider" rules={[{ required: true }]}> 
          <Select placeholder="Select provider">
            <Select.Option value="openai">OpenAI</Select.Option>
            <Select.Option value="azure">Azure OpenAI</Select.Option>
            <Select.Option value="openrouter">OpenRouter</Select.Option>
            <Select.Option value="ollama">Ollama</Select.Option>
            <Select.Option value="deepseek">Deepseek</Select.Option>
            <Select.Option value="google">Google / Vertex</Select.Option>
            <Select.Option value="qwen">Qwen</Select.Option>
            <Select.Option value="zhipu">Zhipu</Select.Option>
            <Select.Option value="lm_studio">LM Studio</Select.Option>
            <Select.Option value="custom">Custom</Select.Option>
          </Select>
        </Form.Item>
        <Form.Item name="api_base" label="API Base (endpoint)">
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>
        <Form.Item name="api_key" label="API Key">
          <Input.Password placeholder="Enter API key (will be moved to ~/.wrenai/.env)" />
        </Form.Item>
        <Form.Item>
          <Checkbox checked={persistKey} onChange={(e) => setPersistKey(e.target.checked)}>
            Persist API key to ~/.wrenai/.env
          </Checkbox>
        </Form.Item>
        <Form.Item name="active_model" label="Active model (for interactive sessions)">
          <Input.Group compact>
            <Select placeholder="Select active model" allowClear style={{ width: '70%' }} onChange={onActiveModelChange}>
              {modelOptions.map((m) => (
                <Select.Option key={m} value={m}>{m}</Select.Option>
              ))}
            </Select>
            <Button onClick={() => {
              form.validateFields(['active_model']).then(values => onActiveModelChange(values.active_model)).catch(() => message.error('Select an active model first'));
            }} style={{ width: '28%' }}>Switch Now</Button>
          </Input.Group>
        </Form.Item>
        <Form.Item name="api_key_env" label="Stored Env Var" tooltip="If the key is already stored in ~/.wrenai/.env this field shows the env var name">
          <Input readOnly />
        </Form.Item>
        <Form.Item
          name="models"
          label="Models (JSON Array)"
          rules={[
            { required: true, message: 'Models JSON is required' },
            {
              validator: async (_: any, value: string) => {
                try {
                  JSON.parse(value || '[]');
                } catch (e) {
                  return Promise.reject(new Error('Invalid JSON'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input.TextArea rows={8} placeholder='[ { "model": "gpt-4", "kwargs": {} } ]' />
        </Form.Item>
        <Form.Item>
            <Space>
              <Button type="primary" onClick={onSave} loading={saving}>Save</Button>
              <Button onClick={onTestConnection} loading={testing}>Test Connection</Button>
            </Space>
        </Form.Item>
      </Form>
      {testResult && (
        <div style={{ marginTop: 12 }}>
          {testResult.ok ? (
            <Alert message="Connection successful" type="success" showIcon description={testResult.status ? `Status: ${testResult.status}` : undefined} />
          ) : (
            <Alert message="Connection failed" type="error" showIcon description={testResult.error || JSON.stringify(testResult)} />
          )}
        </div>
      )}
      <Modal
        visible={confirmVisible}
        title="Confirm saving API key to disk"
        onOk={doSave}
        onCancel={() => setConfirmVisible(false)}
      >
        <p>
          You chose to persist the API key to <code>~/.wrenai/.env</code>. This will store the key on the local disk. Continue?
        </p>
      </Modal>
    </div>
  );
}
