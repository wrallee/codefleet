# Third-party notices

## Graphify

The container installs `graphifyy==0.9.65` from
[Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify).
It is licensed under Apache-2.0.

The installed wheel retains its Apache `LICENSE`, historical `LICENSE-MIT`, and
`NOTICE` at:

```text
/opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/
```

The Docker verify stage checks that all three files are present.

## Swagger UI

The application includes `swagger-ui-dist==5.33.0` from
[swagger-api/swagger-ui](https://github.com/swagger-api/swagger-ui).
It is licensed under Apache-2.0. The distributed package retains its
`LICENSE` and `NOTICE` files under `node_modules/swagger-ui-dist/`.

## Scarf

Swagger UI depends on `@scarf/scarf==1.4.0`, which is licensed under
Apache-2.0. Its `LICENSE` is retained under `node_modules/@scarf/scarf/`.
Package analytics are disabled through `scarfSettings` in `package.json`.
