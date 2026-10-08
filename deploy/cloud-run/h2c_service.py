"""Put the h2c proxy (deploy/h2c-proxy) in front of a Cloud Run service's application container.

Usage:
  python h2c_service.py IN.yaml OUT.yaml --app NAME --proxy-image IMAGE
         [--app-image IMAGE] [--memory 4Gi] [--env K=V ...]
         [--bucket BUCKET --mount PATH]

IN.yaml is `gcloud run services describe SERVICE --format=export`. OUT.yaml goes to
`gcloud run services replace`. Idempotent: run on a service that already has the proxy, it updates
the application container and leaves the proxy in place.

Why: Cloud Run refuses HTTP/1 requests over 32 MiB. With HTTP/2 end to end it imposes no limit, and
neither OpenSign's Parse server nor the gateway's Express speaks h2c — the proxy does.
"""
import argparse
import json
import random
import string

import yaml

parser = argparse.ArgumentParser()
parser.add_argument('src')
parser.add_argument('dst')
parser.add_argument('--app', required=True)
parser.add_argument('--proxy-image', required=True)
parser.add_argument('--app-image')
parser.add_argument('--memory')
parser.add_argument('--env', action='append', default=[])
parser.add_argument('--bucket')
parser.add_argument('--mount')
args = parser.parse_args()

doc = yaml.safe_load(open(args.src))
template = doc['spec']['template']
spec = template['spec']
containers = spec['containers']
app = next((c for c in containers if c.get('name') != 'proxy'), containers[0])
app['name'] = args.app
app.pop('ports', None)
if args.app_image:
    app['image'] = args.app_image

env = {e['name']: e for e in app.get('env', [])}
env['PORT'] = {'name': 'PORT', 'value': '8081'}
for pair in args.env:
    key, value = pair.split('=', 1)
    env[key] = {'name': key, 'value': value}
app['env'] = list(env.values())

if args.memory:
    app.setdefault('resources', {}).setdefault('limits', {})['memory'] = args.memory

probe = app.get('startupProbe')
if probe:
    for kind in ('tcpSocket', 'httpGet'):
        if kind in probe:
            probe[kind]['port'] = 8081

if args.bucket and args.mount:
    volumes = [v for v in spec.get('volumes', []) if v.get('name') != 'files']
    volumes.append({'name': 'files', 'csi': {'driver': 'gcsfuse.run.googleapis.com', 'volumeAttributes': {'bucketName': args.bucket}}})
    spec['volumes'] = volumes
    mounts = [m for m in app.get('volumeMounts', []) if m.get('name') != 'files']
    mounts.append({'name': 'files', 'mountPath': args.mount})
    app['volumeMounts'] = mounts

proxy = {
    'name': 'proxy',
    'image': args.proxy_image,
    'ports': [{'containerPort': 8080, 'name': 'h2c'}],
    'env': [{'name': 'UPSTREAM_PORT', 'value': '8081'}],
    'resources': {'limits': {'cpu': '1', 'memory': '256Mi'}},
    'startupProbe': {'tcpSocket': {'port': 8080}, 'periodSeconds': 5, 'failureThreshold': 10, 'timeoutSeconds': 3},
}
spec['containers'] = [proxy, app]

annotations = template['metadata'].setdefault('annotations', {})
annotations['run.googleapis.com/container-dependencies'] = json.dumps({'proxy': [args.app]})
# Cloud Storage volumes need the second-generation execution environment.
annotations['run.googleapis.com/execution-environment'] = 'gen2'
for key in ('run.googleapis.com/client-name', 'run.googleapis.com/client-version'):
    annotations.pop(key, None)
labels = template['metadata'].setdefault('labels', {})
labels['client.knative.dev/nonce'] = ''.join(random.choice(string.ascii_lowercase) for _ in range(10))
template['metadata'].pop('name', None)

yaml.safe_dump(doc, open(args.dst, 'w'), sort_keys=False)
print('ok', [c['name'] for c in spec['containers']])
