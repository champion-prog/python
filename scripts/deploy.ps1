param(
    [string]$StackName = 'smartqueue',
    [string]$ApplicationName = 'smartqueue',
    [string]$Region = '',
    [string]$AlertsEmail = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Region) {
    $Region = (& aws configure get region).Trim()
}
if (-not $Region) {
    throw 'Set an AWS CLI default region or pass -Region.'
}

Push-Location $root
try {
    & sam build --template-file 'infrastructure\template.yaml'
    if ($LASTEXITCODE -ne 0) { throw 'SAM build failed.' }

    $parameters = @("ApplicationName=$ApplicationName", 'StageName=prod')
    if ($AlertsEmail) { $parameters += "AlertsEmail=$AlertsEmail" }
    & sam deploy --stack-name $StackName --region $Region --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset --parameter-overrides @parameters
    if ($LASTEXITCODE -ne 0) { throw 'SAM deployment failed.' }

    $stack = (& aws cloudformation describe-stacks --stack-name $StackName --region $Region --output json | ConvertFrom-Json).Stacks[0]
    $outputs = @{}
    foreach ($output in $stack.Outputs) { $outputs[$output.OutputKey] = $output.OutputValue }

    $envFile = @(
        "VITE_AWS_REGION=$Region"
        "VITE_COGNITO_USER_POOL_ID=$($outputs['UserPoolId'])"
        "VITE_COGNITO_CLIENT_ID=$($outputs['UserPoolClientId'])"
        "VITE_API_URL=$($outputs['ApiUrl'])"
    )
    Set-Content -LiteralPath '.env.production' -Value $envFile -Encoding utf8

    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend production build failed.' }
    & aws s3 sync 'frontend\dist' "s3://$($outputs['FrontendBucketName'])" --delete --cache-control 'public,max-age=31536000,immutable' --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Frontend upload failed.' }
    & aws s3 cp 'frontend\dist\index.html' "s3://$($outputs['FrontendBucketName'])/index.html" --cache-control 'no-cache' --content-type 'text/html' --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'Frontend entry point upload failed.' }

    Write-Host "SmartQueue deployed to $($outputs['FrontendUrl'])"
    Write-Host "API URL: $($outputs['ApiUrl'])"
    Write-Host "Cognito user pool: $($outputs['UserPoolId'])"
} finally {
    Pop-Location
}
