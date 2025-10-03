import React from 'react';
import dynamic from 'next/dynamic';

const LLMConfigForm = dynamic(() => import('@/components/settings/LLMConfigForm'), { ssr: false });

export default function LLMSettingsPage() {
  return (
    <div style={{ padding: 24 }}>
      <h1>AI / LLM Settings</h1>
      <LLMConfigForm />
    </div>
  );
}
