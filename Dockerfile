# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS web-build
WORKDIR /source/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api-build
WORKDIR /source
COPY SqlSimCity.slnx Directory.Build.props Directory.Packages.props ./
COPY src/SqlSimCity.Api/SqlSimCity.Api.csproj src/SqlSimCity.Api/
COPY src/SqlSimCity.Domain/SqlSimCity.Domain.csproj src/SqlSimCity.Domain/
COPY src/SqlSimCity.Contracts/SqlSimCity.Contracts.csproj src/SqlSimCity.Contracts/
COPY src/SqlSimCity.Storage/SqlSimCity.Storage.csproj src/SqlSimCity.Storage/
COPY src/SqlSimCity.SqlServer/SqlSimCity.SqlServer.csproj src/SqlSimCity.SqlServer/
COPY src/SqlSimCity.Collection/SqlSimCity.Collection.csproj src/SqlSimCity.Collection/
RUN dotnet restore src/SqlSimCity.Api/SqlSimCity.Api.csproj
COPY src/ src/
COPY sql/ sql/
COPY fixtures/ fixtures/
COPY --from=web-build /source/web/dist web/dist
RUN dotnet publish src/SqlSimCity.Api/SqlSimCity.Api.csproj --configuration Release --no-restore --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
RUN mkdir /data && chown $APP_UID:$APP_UID /data
COPY --from=api-build --chown=$APP_UID:$APP_UID /app/publish ./
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_EnableDiagnostics=0 \
    DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "SqlSimCity.Api.dll"]
