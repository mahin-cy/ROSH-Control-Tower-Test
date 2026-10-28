import type { MqttClient } from 'mqtt';

// Lets health-route.ts read MQTT connection state without importing
// mqtt-client.ts directly or creating a circular dependency with index.ts.
let client: MqttClient | undefined;

export function setMqttClient(mqttClient: MqttClient): void {
  client = mqttClient;
}

export function getMqttClient(): MqttClient | undefined {
  return client;
}
